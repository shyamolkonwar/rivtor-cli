import type { AgentError, DeployResult } from "./shared.js";
import { NOT_LOGGED_IN_MESSAGE, TOKENS_URL } from "./constants.js";

type Stage = AgentError["stage"];
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Every failure surfaced by the CLI/MCP carries an AgentError, same shape as the API's. */
export class RivtorApiError extends Error {
  readonly status: number;
  readonly agentError: AgentError;
  constructor(status: number, agentError: AgentError) {
    super(agentError.cause);
    this.name = "RivtorApiError";
    this.status = status;
    this.agentError = agentError;
  }
}

export function notLoggedInError(): RivtorApiError {
  return new RivtorApiError(401, {
    status: "failed",
    stage: "auth",
    code: "not_logged_in",
    cause: NOT_LOGGED_IN_MESSAGE,
    fix: `Run \`rivtor login\` with a token from ${TOKENS_URL}, or set the RIVTOR_TOKEN environment variable.`,
    retryable: false,
  });
}

function isAgentError(v: unknown): v is AgentError {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.code === "string" && typeof o.cause === "string" && typeof o.fix === "string";
}

function httpReason(status: number): string {
  const map: Record<number, string> = {
    400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden",
    404: "Not Found", 409: "Conflict", 413: "Payload Too Large", 422: "Unprocessable Entity",
    429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
    503: "Service Unavailable", 504: "Gateway Timeout",
  };
  return map[status] ?? "Error";
}

/**
 * Turns an error response into an AgentError. Accepts an AgentError body, `{ error: AgentError }`,
 * `{ error: "msg" }`/`{ message: "msg" }` or non-JSON bodies (proxies, gateways).
 */
export function parseErrorBody(status: number, bodyText: string, stage: Stage): AgentError {
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    parsed = undefined;
  }
  if (isAgentError(parsed)) return { ...parsed, status: parsed.status ?? "failed", stage: parsed.stage ?? stage };
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (isAgentError(o.error)) return { ...o.error, stage: o.error.stage ?? stage };
  }

  if (status === 401) {
    return {
      status: "failed",
      stage: "auth",
      code: "unauthorized",
      cause: "Not logged in or the API token is invalid, expired or revoked.",
      fix: `Run \`rivtor login\` with a new token from ${TOKENS_URL} (or update RIVTOR_TOKEN).`,
      retryable: false,
    };
  }

  let message: string | undefined;
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (typeof o.message === "string") message = o.message;
    else if (typeof o.error === "string") message = o.error;
  }
  const snippet = bodyText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const retryable = status >= 500 || status === 429;
  return {
    status: "failed",
    stage,
    code: status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 429 ? "rate_limited" : `http_${status}`,
    cause: message ?? `Rivtor API returned ${status} ${httpReason(status)}${snippet && !message ? `: ${snippet}` : ""}`,
    fix: retryable
      ? "This is a temporary server-side problem. Wait a few seconds, then retry the same command."
      : status === 404
        ? "Check the project slug (`rivtor projects` lists yours), then retry."
        : "Check the arguments of the request, then retry.",
    retryable,
  };
}

export interface ApiClientOptions {
  apiUrl: string;
  token: string | null;
  fetch?: FetchLike;
  userAgent?: string;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  form?: FormData;
  stage?: Stage;
  /** return the raw Response (for streaming downloads) */
  raw?: boolean;
  signal?: AbortSignal;
  /** allow calling without a token (healthz) */
  anonymous?: boolean;
}

export class ApiClient {
  readonly apiUrl: string;
  readonly token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;

  constructor(opts: ApiClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = opts.userAgent ?? "rivtor-cli";
  }

  get loggedIn(): boolean {
    return Boolean(this.token);
  }

  buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const stage: Stage = opts.stage ?? "return";
    if (!this.token && !opts.anonymous) throw notLoggedInError();
    const headers: Record<string, string> = { "user-agent": this.userAgent, accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.buildUrl(path, opts.query), { method, headers, body, signal: opts.signal });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      const reason = (err as Error & { cause?: { code?: string; message?: string } })?.cause?.code
        ?? (err as Error)?.message ?? String(err);
      throw new RivtorApiError(0, {
        status: "failed",
        stage,
        code: "network_error",
        cause: `Could not reach the Rivtor API at ${this.apiUrl} (${reason}).`,
        fix: "Check your internet connection (and RIVTOR_API_URL if you set it), then retry.",
        retryable: true,
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new RivtorApiError(res.status, parseErrorBody(res.status, text, stage));
    }
    if (opts.raw) return res as unknown as T;
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RivtorApiError(res.status, {
        status: "failed",
        stage,
        code: "bad_response",
        cause: `Rivtor API returned a non-JSON response for ${method} ${path}.`,
        fix: "Retry in a moment; if it persists, check RIVTOR_API_URL points at the Rivtor API.",
        retryable: true,
      });
    }
  }

  // ---- endpoints -------------------------------------------------------------------------

  me(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/me", { stage: "auth" });
  }

  listProjects(): Promise<unknown> {
    return this.request("GET", "/v1/projects");
  }

  getProject(slug: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/projects/${enc(slug)}`);
  }

  createDeployment(
    slug: string,
    input: { source: Blob; dryRun: boolean; wait: boolean; env?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.set("dry_run", String(input.dryRun));
    form.set("wait", String(input.wait));
    if (input.env && Object.keys(input.env).length > 0) form.set("env", JSON.stringify(input.env));
    form.set("source", input.source, "source.tar.gz");
    return this.request("POST", `/v1/projects/${enc(slug)}/deployments`, { form, stage: "upload", signal });
  }

  getDeployment(id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/deployments/${enc(id)}`);
  }

  getDeploymentLogs(id: string, after?: string | number | null): Promise<unknown> {
    return this.request("GET", `/v1/deployments/${enc(id)}/logs`, { query: { after: after ?? undefined } });
  }

  projectLogs(slug: string, q: { service?: string; since?: string; level?: string; limit?: number; summary?: boolean }): Promise<unknown> {
    return this.request("GET", `/v1/projects/${enc(slug)}/logs`, {
      query: { service: q.service, since: q.since, level: q.level, limit: q.limit, summary: q.summary === undefined ? undefined : q.summary ? 1 : 0 },
    });
  }

  envList(slug: string): Promise<unknown> {
    return this.request("GET", `/v1/projects/${enc(slug)}/env`, { stage: "env" });
  }

  envSet(slug: string, vars: Record<string, string>, service?: string): Promise<unknown> {
    return this.request("PUT", `/v1/projects/${enc(slug)}/env`, { json: { vars, service }, stage: "env" });
  }

  envRemove(slug: string, keys: string[], service?: string): Promise<unknown> {
    return this.request("DELETE", `/v1/projects/${enc(slug)}/env`, { json: { keys, service }, stage: "env" });
  }

  rollback(slug: string, releaseId?: string): Promise<unknown> {
    return this.request("POST", `/v1/projects/${enc(slug)}/rollback`, { json: releaseId ? { release_id: releaseId } : {}, stage: "rollback" });
  }

  dbQuery(slug: string, sql: string): Promise<unknown> {
    return this.request("POST", `/v1/projects/${enc(slug)}/db/query`, { json: { sql }, stage: "db" });
  }

  dbConnection(slug: string): Promise<unknown> {
    return this.request("POST", `/v1/projects/${enc(slug)}/db/connection`, { json: {}, stage: "db" });
  }

  dbExport(slug: string): Promise<Response> {
    return this.request<Response>("GET", `/v1/projects/${enc(slug)}/db/export`, { raw: true, stage: "db" });
  }

  domainAdd(slug: string, hostname: string, service?: string): Promise<unknown> {
    return this.request("POST", `/v1/projects/${enc(slug)}/domains`, { json: { hostname, service }, stage: "domain" });
  }

  destroy(slug: string, confirmToken?: string): Promise<Record<string, unknown>> {
    return this.request("DELETE", `/v1/projects/${enc(slug)}`, { query: { confirm: confirmToken } });
  }

  checkout(input: { plan: string; interval?: string; provider?: string; currency?: string }): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/billing/checkout", { json: input, stage: "limits" });
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

// ---- response normalisation (the API is evolving; be liberal in what we accept) ----------

const TERMINAL = new Set(["live", "failed", "needs_input", "cancelled", "canceled", "error"]);

export interface NormalizedDeployment {
  id: string;
  status: string;
  stage: string | null;
  terminal: boolean;
  result: DeployResult | null;
}

export function looksLikeDeployResult(v: unknown): v is DeployResult {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.status === "string" &&
    ["live", "failed", "needs_input"].includes(o.status) &&
    (typeof o.deploymentId === "string" || "urls" in o || "error" in o)
  );
}

export function extractDeploymentId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  for (const key of ["deploymentId", "deployment_id", "id"]) {
    if (typeof o[key] === "string" && o[key]) return o[key] as string;
  }
  if (o.deployment && typeof o.deployment === "object") return extractDeploymentId(o.deployment);
  return null;
}

export function normalizeDeployment(raw: unknown, fallbackId: string): NormalizedDeployment {
  const outer = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = (outer.deployment && typeof outer.deployment === "object" ? outer.deployment : outer) as Record<string, unknown>;
  const id = extractDeploymentId(d) ?? fallbackId;
  const status = typeof d.status === "string" ? d.status : "pending";
  let result: DeployResult | null = null;
  for (const cand of [outer.result, d.result]) {
    if (looksLikeDeployResult(cand)) {
      result = cand;
      break;
    }
  }
  if (!result && looksLikeDeployResult(d) && "urls" in d) result = d as unknown as DeployResult;
  const stageField = typeof d.stage === "string" ? d.stage : typeof d.current_stage === "string" ? d.current_stage : null;
  const terminal = TERMINAL.has(status) || result !== null;
  return { id, status: result?.status ?? status, stage: stageField ?? (terminal ? null : status), terminal, result };
}

export interface LogLine {
  id: string | number | null;
  stage: string | null;
  service: string | null;
  level: string | null;
  ts: string | null;
  message: string;
}

export function normalizeLogs(raw: unknown): { lines: LogLine[]; cursor: string | number | null } {
  let arr: unknown[] = [];
  let cursor: string | number | null = null;
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of ["logs", "lines", "items", "data"]) {
      if (Array.isArray(o[key])) {
        arr = o[key] as unknown[];
        break;
      }
    }
    for (const key of ["next", "cursor", "after", "lastId"]) {
      if (typeof o[key] === "string" || typeof o[key] === "number") cursor = o[key] as string | number;
    }
  } else if (typeof raw === "string") {
    arr = raw.split("\n").filter(Boolean);
  }
  const lines: LogLine[] = arr.map((item) => {
    if (typeof item === "string") return { id: null, stage: null, service: null, level: null, ts: null, message: item };
    const o = (item ?? {}) as Record<string, unknown>;
    const str = (k: string[]) => {
      for (const key of k) if (typeof o[key] === "string") return o[key] as string;
      return null;
    };
    const id = typeof o.id === "number" || typeof o.id === "string" ? (o.id as string | number) : null;
    return {
      id,
      stage: str(["stage"]),
      service: str(["service", "service_name"]),
      level: str(["level", "stream"]),
      ts: str(["ts", "timestamp", "time", "created_at", "createdAt"]),
      message: str(["message", "line", "text", "msg"]) ?? "",
    };
  });
  if (cursor === null) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].id !== null) {
        cursor = lines[i].id;
        break;
      }
    }
  }
  return { lines, cursor };
}
