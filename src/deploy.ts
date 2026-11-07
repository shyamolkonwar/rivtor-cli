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
import { PackError, type PackResult, manifestDir, packBlobs, packDir } from "./pack.js";
import { type ResolvedProject, resolveProject, writeRivtorJson } from "./project.js";

export type ProgressEvent =
  /** bytes = what gets uploaded; changed = files the server didn't have yet (incremental upload) */
  | { type: "packed"; files: number; bytes: number; changed?: number }
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
  /** rebuild every service without build caches (`--clean`) */
  clean?: boolean;
  /** upload only changed files (manifest + missing blobs). Default true for real deploys; falls back to a full tarball on older APIs. */
  incremental?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type PackInfo = Omit<PackResult, "blob" | "cleanup"> & {
  /** incremental upload: number of files actually uploaded */
  uploadedFiles?: number;
};

export type DeployOutcome =
  | { kind: "result"; project: ResolvedProject; result: DeployResult; pack: PackInfo }
  | { kind: "plan"; project: ResolvedProject; plan: DeployPlan; raw: unknown; pack: PackInfo }
  | { kind: "started"; project: ResolvedProject; deploymentId: string; pack: PackInfo };

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
  let created: Record<string, unknown> | null = null;
  let packInfo: PackInfo | null = null;
  if (!dryRun && opts.incremental !== false) {
    // retry once if the server lost blobs between the manifest and the deploy request
    for (let attempt = 0; attempt < 2 && !created; attempt++) {
      try {
        const inc = await incrementalUpload(client, dir, project.slug, opts, emit);
        if (!inc) break; // API without incremental upload: full tarball below
        created = inc.created;
        packInfo = inc.info;
      } catch (err) {
        const code = err instanceof RivtorApiError ? err.agentError.code : "";
        if (attempt === 0 && (code === "missing_blobs" || code === "manifest_not_found")) continue;
        throw err;
      }
    }
  }

  if (!created || !packInfo) {
    let pack: PackResult;
    try {
      pack = await packDir(dir, { maxBytes: opts.maxBytes });
    } catch (err) {
      if (err instanceof PackError) throw new RivtorApiError(0, packErrorToAgentError(err));
      throw err;
    }
    packInfo = { file: pack.file, bytes: pack.bytes, files: pack.files, rawBytes: pack.rawBytes };
    emit({ type: "packed", files: pack.files.length, bytes: pack.bytes });
    try {
      emit({ type: "uploading", project: project.slug });
      created = await client.createDeployment(project.slug, {
        source: await pack.blob(),
        dryRun,
        // dry runs answer synchronously; real deploys start async and we poll for progress
        wait: dryRun,
        env: opts.env,
        clean: opts.clean,
      });
    } finally {
      await pack.cleanup();
    }
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

/**
 * Incremental upload: manifest of every file (sha256) -> server answers with the hashes it lacks ->
 * upload only those (with the deploy request). Returns null when the API doesn't support it.
 */
async function incrementalUpload(
  client: ApiClient,
  dir: string,
  slug: string,
  opts: DeployOptions,
  emit: (ev: ProgressEvent) => void,
): Promise<{ created: Record<string, unknown>; info: PackInfo } | null> {
  let manifest;
  let rawBytes;
  try {
    ({ manifest, rawBytes } = await manifestDir(dir));
  } catch (err) {
    if (err instanceof PackError) throw new RivtorApiError(0, packErrorToAgentError(err));
    throw err;
  }
  let res: Record<string, unknown>;
  try {
    res = await client.uploadManifest(slug, manifest);
  } catch (err) {
    if (err instanceof RivtorApiError && (err.status === 404 || err.status === 405)) return null;
    throw err;
  }
  const manifestId = res?.manifestId;
  const missing = res?.missing;
  if (typeof manifestId !== "string" || !Array.isArray(missing)) return null;
  let blobs = null;
  try {
    blobs = missing.length ? await packBlobs(dir, manifest, missing as string[], opts.maxBytes) : null;
  } catch (err) {
    if (err instanceof PackError) throw new RivtorApiError(0, packErrorToAgentError(err));
    throw err;
  }
  const files = manifest.files.map((f) => f.path).concat((manifest.symlinks ?? []).map((l) => l.path));
  emit({ type: "packed", files: files.length, bytes: blobs?.bytes ?? 0, changed: blobs?.count ?? 0 });
  try {
    emit({ type: "uploading", project: slug });
    const created = await client.createManifestDeployment(slug, {
      manifestId,
      ...(blobs ? { blobs: await blobs.blob() } : {}),
      dryRun: false,
      wait: false,
      env: opts.env,
      clean: opts.clean,
    });
    return {
      created,
      info: { file: "", bytes: blobs?.bytes ?? 0, files, rawBytes, uploadedFiles: blobs?.count ?? 0 },
    };
  } finally {
    await blobs?.cleanup();
  }
}

/** Server-side long-poll per status request (the API returns as soon as the deployment finishes). */
const LONG_POLL_S = 2;

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
    const cycleStart = Date.now();
    // logs and status in parallel; the status request long-polls and returns early on completion
    const logsP = client.getDeploymentLogs(deploymentId, cursor).catch(() => null);
    try {
      dep = normalizeDeployment(await client.getDeployment(deploymentId, LONG_POLL_S), deploymentId);
      transientFailures = 0;
    } catch (err) {
      await logsP;
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
      const raw = await logsP;
      if (raw !== null) {
        const logs = normalizeLogs(raw);
        for (const line of logs.lines) {
          if (line.stage) enterStage(line.stage);
          emit({ type: "log", line });
        }
        if (logs.cursor !== null) cursor = logs.cursor;
      }
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
    // an API that long-polled already waited; older APIs answer at once, so sleep the remainder
    const spent = Date.now() - cycleStart;
    if (spent < interval) await sleep(interval - spent);
    if (Date.now() - started > 30_000) interval = Math.min(Math.max(interval, 2000), 5000);
  }
}
