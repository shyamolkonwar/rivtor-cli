import type { AgentError, DeployPlan, DeployResult } from "./shared.js";
import { resolve } from "node:path";
import {
  type ApiClient,
  type LogLine,
  RivtorApiError,
  extractDeploymentId,
  looksLikeDeployResult,
  normalizeDeployment,
  normalizeLogs,
} from "./api.js";
import { DASHBOARD_URL } from "./constants.js";
import { PackError, type PackResult, packDir } from "./pack.js";
import { type ResolvedProject, resolveProject, writeRivtorJson } from "./project.js";

export type ProgressEvent =
  | { type: "packed"; files: number; bytes: number }
  | { type: "uploading"; project: string }
  | { type: "started"; deploymentId: string }
  | { type: "stage"; stage: string }
  | { type: "log"; line: LogLine };

export interface DeployOptions {
  dir: string;
  project?: string | null;
  dryRun?: boolean;
  /** wait for the deployment to finish (polling). Default true. */
  wait?: boolean;
  env?: Record<string, string>;
  onProgress?: (ev: ProgressEvent) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** write rivtor.json after a successful (non-dry) deploy request. Default true. */
  saveProject?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type DeployOutcome =
  | { kind: "result"; project: ResolvedProject; result: DeployResult; pack: Omit<PackResult, "blob" | "cleanup"> }
  | { kind: "plan"; project: ResolvedProject; plan: DeployPlan; raw: unknown; pack: Omit<PackResult, "blob" | "cleanup"> }
  | { kind: "started"; project: ResolvedProject; deploymentId: string; pack: Omit<PackResult, "blob" | "cleanup"> };

const STAGES = new Set(["upload", "detect", "plan", "provision", "build", "migrate", "release", "return"]);
const asStage = (s: string | null): AgentError["stage"] => (s && STAGES.has(s) ? (s as AgentError["stage"]) : "build");

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function looksLikePlan(v: unknown): v is DeployPlan {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.services) && Array.isArray(o.assumptions ?? []) && ("missingSecrets" in o || "env" in o || "data" in o);
}

export function packErrorToAgentError(err: PackError): AgentError {
  return { status: "failed", stage: "upload", code: err.code, cause: err.message, fix: err.fix, retryable: false };
}

/**
 * Packs `dir`, uploads it and (unless `wait: false`) polls until the deployment is live,
 * failed or needs input. Throws RivtorApiError for API/auth/pack failures.
 */
export async function runDeploy(client: ApiClient, opts: DeployOptions): Promise<DeployOutcome> {
  const dir = resolve(opts.dir);
  const dryRun = Boolean(opts.dryRun);
  const wait = opts.wait ?? true;
  const emit = opts.onProgress ?? (() => {});
  const sleep = opts.sleep ?? defaultSleep;

  if (!client.loggedIn) {
    // fail fast, before spending time packing
    await client.request("GET", "/v1/me", { stage: "auth" });
  }

  const project = await resolveProject(dir, opts.project);
  let pack: PackResult;
  try {
    pack = await packDir(dir, { maxBytes: opts.maxBytes });
  } catch (err) {
    if (err instanceof PackError) throw new RivtorApiError(0, packErrorToAgentError(err));
    throw err;
  }
  const packInfo = { file: pack.file, bytes: pack.bytes, files: pack.files, rawBytes: pack.rawBytes };
  emit({ type: "packed", files: pack.files.length, bytes: pack.bytes });

  let created: Record<string, unknown>;
  try {
    emit({ type: "uploading", project: project.slug });
    created = await client.createDeployment(project.slug, {
      source: await pack.blob(),
      dryRun,
      // dry runs answer synchronously; real deploys start async and we poll for progress
      wait: dryRun,
      env: opts.env,
    });
  } finally {
    await pack.cleanup();
  }

  if (dryRun) {
    const res = created as Record<string, unknown>;
    if (looksLikeDeployResult(res)) return { kind: "result", project, result: res, pack: packInfo };
    const plan = looksLikePlan(res) ? res : looksLikePlan(res?.plan) ? (res.plan as DeployPlan) : null;
    if (plan) return { kind: "plan", project, plan, raw: res, pack: packInfo };
    return { kind: "result", project, result: res as unknown as DeployResult, pack: packInfo };
  }

  if (opts.saveProject !== false && project.source !== "rivtor.json") {
    await writeRivtorJson(dir, project.slug).catch(() => undefined);
  }

  if (looksLikeDeployResult(created)) return { kind: "result", project, result: created, pack: packInfo };
  const deploymentId = extractDeploymentId(created);
  if (!deploymentId) {
    throw new RivtorApiError(200, {
      status: "failed",
      stage: "upload",
      code: "bad_response",
      cause: "The API accepted the upload but did not return a deployment id.",
      fix: "Run `rivtor status` to see whether a deployment started, then retry.",
      retryable: true,
    });
  }
  emit({ type: "started", deploymentId });
  if (!wait) return { kind: "started", project, deploymentId, pack: packInfo };

  const result = await waitForDeployment(client, deploymentId, project.slug, {
    onProgress: emit,
    pollIntervalMs: opts.pollIntervalMs,
    timeoutMs: opts.timeoutMs,
    sleep,
  });
  return { kind: "result", project, result, pack: packInfo };
}

export async function waitForDeployment(
  client: ApiClient,
  deploymentId: string,
  project: string,
  opts: { onProgress?: (ev: ProgressEvent) => void; pollIntervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeployResult> {
  const emit = opts.onProgress ?? (() => {});
  const sleep = opts.sleep ?? defaultSleep;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
  let interval = opts.pollIntervalMs ?? 1000;
  let cursor: string | number | null = null;
  let lastStage = null as string | null;
  const seenStages = new Set<string>();
  // stages only move forward: log lines and deployment status may disagree briefly
  const enterStage = (stage: string) => {
    if (seenStages.has(stage)) return;
    seenStages.add(stage);
    lastStage = stage;
    emit({ type: "stage", stage });
  };
  let transientFailures = 0;

  for (;;) {
    let dep;
    try {
      dep = normalizeDeployment(await client.getDeployment(deploymentId), deploymentId);
      transientFailures = 0;
    } catch (err) {
      // ride out short network blips / 5xx while polling
      if (err instanceof RivtorApiError && err.agentError.retryable && transientFailures < 5) {
        transientFailures++;
        await sleep(interval * 2);
        continue;
      }
      throw err;
    }

    // deployment status is the source of truth for the current stage; logs fill in details
    if (dep.stage && !dep.terminal) enterStage(dep.stage);

    try {
      const logs = normalizeLogs(await client.getDeploymentLogs(deploymentId, cursor));
      for (const line of logs.lines) {
        if (line.stage) enterStage(line.stage);
        emit({ type: "log", line });
      }
      if (logs.cursor !== null) cursor = logs.cursor;
    } catch {
      // log streaming is best-effort; deployment status is the source of truth
    }

    if (dep.terminal) {
      if (dep.result) return dep.result;
      const status = dep.status === "live" || dep.status === "needs_input" ? dep.status : "failed";
      return {
        status,
        deploymentId,
        project,
        urls: {},
        services: [],
        data: [],
        dashboardUrl: `${DASHBOARD_URL}/projects/${project}`,
        durationMs: Date.now() - started,
        ...(status === "failed"
          ? {
              error: {
                status: "failed",
                stage: asStage(lastStage),
                code: dep.status === "cancelled" || dep.status === "canceled" ? "cancelled" : "unknown",
                cause: `Deployment ${dep.status}.`,
                fix: `Run \`rivtor logs --build ${deploymentId}\` to see what happened, fix it, then call deploy again.`,
                retryable: true,
              },
            }
          : {}),
      };
    }

    if (Date.now() - started > timeoutMs) {
      throw new RivtorApiError(0, {
        status: "failed",
        stage: asStage(lastStage),
        code: "wait_timeout",
        cause: `Deployment ${deploymentId} is still running after ${Math.round(timeoutMs / 60000)} minutes.`,
        fix: `Run \`rivtor status ${project}\` or \`rivtor logs --build ${deploymentId}\` to check on it.`,
        retryable: true,
      });
    }
    await sleep(interval);
    if (Date.now() - started > 30_000) interval = Math.min(Math.max(interval, 2000), 5000);
  }
}
