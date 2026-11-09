import type { AgentError } from "./shared.js";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ApiClient, RivtorApiError } from "./api.js";
import { TOKENS_URL } from "./constants.js";
import { runDeploy } from "./deploy.js";
import { ProjectConfigError, SLUG_RE, resolveProject } from "./project.js";

export interface McpDeps {
  /** Resolved per call so `rivtor login` / env changes apply without restarting the server. */
  getClient: () => Promise<ApiClient>;
  version: string;
  cwd?: () => string;
  /** test hooks */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Masks credentials that might appear in API payloads (tokens, URL passwords). */
export function redactSecrets(text: string): string {
  return text
    .replace(/rvt_[A-Za-z0-9]{6,}/g, "rvt_••••")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:/?#@\s"]+):([^@/\s"]+)@/gi, "$1:••••@")
    .replace(/\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, "$1_$2_••••");
}

function ok(value: unknown, opts: { redact?: boolean } = {}): ToolResult {
  const text = JSON.stringify(value ?? { ok: true }, null, 2);
  return { content: [{ type: "text", text: opts.redact === false ? text : redactSecrets(text) }] };
}

function fail(err: AgentError): ToolResult {
  return { content: [{ type: "text", text: redactSecrets(JSON.stringify(err, null, 2)) }], isError: true };
}

function toAgentError(err: unknown, stage: AgentError["stage"]): AgentError {
  if (err instanceof RivtorApiError) {
    const e = err.agentError;
    if (e.code === "not_logged_in" || e.code === "unauthorized") {
      return {
        ...e,
        fix: `Run \`npx rivtor login\` in a terminal (token from ${TOKENS_URL}), or add RIVTOR_TOKEN to this MCP server's env config, then retry.`,
      };
    }
    return e;
  }
  if (err instanceof ProjectConfigError) {
    return { status: "failed", stage, code: "invalid_project", cause: err.message, fix: "Pass a valid `project` slug (lowercase letters, digits, dashes), then retry.", retryable: false };
  }
  return {
    status: "failed",
    stage,
    code: "client_error",
    cause: (err as Error)?.message ?? String(err),
    fix: "Retry the call; if it keeps failing, run the equivalent `rivtor` CLI command to see details.",
    retryable: true,
  };
}

const projectArg = z
  .string()
  .regex(SLUG_RE, "lowercase letters, digits and dashes, starting with a letter")
  .optional()
  .describe("Project slug. Optional: defaults to rivtor.json in the working directory, else its folder name.");

export const TOOL_NAMES = [
  "deploy",
  "status",
  "logs",
  "env_set",
  "rollback",
  "db",
  "db_connection",
  "db_export",
  "domain_add",
  "destroy",
  "upgrade",
  "list_projects",
  "verify", "issues", "issue_resolve", "verify_fix", "verify_journey",
  "import", "import_status", "import_cutover", "import_undo",
] as const;

/** Annotation presets: every tool is either read-only or a write that can change or delete data.
 *  openWorldHint is true only for tools that reach outside Rivtor (live apps, other hosts, payment providers). */
export const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "rivtor", version: deps.version },
    {
      instructions:
        "Rivtor deploys any repo (frontend + backend + Postgres/Redis/storage) with one `deploy` call and returns live URLs. " +
        "A deploy result has status `live` (with URLs), `failed` (with error.cause, error.file and error.fix; a redeploy rebuilds only changed services) " +
        "or `needs_input` (missing secrets, which `env_set` stores before the next deploy). Results never contain secret values.",
    },
  );
  const cwd = deps.cwd ?? (() => process.cwd());

  const slugFor = async (project: string | undefined, path?: string) =>
    project ?? (await resolveProject(resolve(cwd(), path ?? "."))).slug;

  const wrap =
    <A>(stage: AgentError["stage"], fn: (args: A, extra: { sendNotification: (n: never) => Promise<void>; _meta?: { progressToken?: string | number } }) => Promise<ToolResult>) =>
    async (args: A, extra: unknown): Promise<ToolResult> => {
      try {
        return await fn(args, extra as never);
      } catch (err) {
        return fail(toAgentError(err, stage));
      }
    };

  const projectRequest = async (project: string | undefined, method: string, suffix: string, options: Parameters<ApiClient["request"]>[2] = {}) => {
    const client = await deps.getClient();
    return ok(await client.request(method, `/v1/projects/${encodeURIComponent(await slugFor(project))}${suffix}`, options));
  };
  server.registerTool("verify", {
    title: "Verify an app",
    description: "Run safe live checks against a deployed project and return the verdict, issues and private report URL. Does not redeploy or change the app.",
    inputSchema: { project: projectArg }, annotations: { ...READ, openWorldHint: true },
  }, wrap("return", async ({ project }) => projectRequest(project, "POST", "/verify", { json: {} })));
  server.registerTool("issues", {
    title: "List issues",
    description: "List persistent verification, security and production issue groups for a project, with pagination and their current disposition.",
    inputSchema: { project: projectArg, status: z.enum(["open", "resolved", "dismissed", "all"]).optional(), severity: z.enum(["critical", "warning", "info"]).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(10000).optional() },
    annotations: READ,
  }, wrap("return", async ({ project, ...query }) => projectRequest(project, "GET", "/issues", { query })));
  server.registerTool("issue_resolve", {
    title: "Resolve or dismiss an issue",
    description: "Mark an issue as resolved (fixed) or dismissed (false positive) for this project. A resolved issue reopens on recurrence.",
    inputSchema: { project: projectArg, id: z.string().uuid(), status: z.enum(["resolved", "dismissed"]) },
    annotations: { ...WRITE, idempotentHint: true },
  }, wrap("return", async ({ project, id, status }) => projectRequest(project, "POST", `/issues/${encodeURIComponent(id)}/resolve`, { json: { status } })));
  server.registerTool("verify_fix", {
    title: "Apply verification fixes",
    description: "Apply server-validated configuration fixes (canonical URL, same-project CORS, safe security headers) for verification issues, then verify again. Requires consent: true. Does not modify application code or database schemas.",
    inputSchema: { project: projectArg, consent: z.literal(true), issue_ids: z.array(z.string().uuid()).max(20).optional(), fixes: z.array(z.record(z.string(), z.unknown())).max(20).optional() },
    annotations: { ...WRITE, openWorldHint: true },
  }, wrap("return", async ({ project, ...json }) => projectRequest(project, "POST", "/verify-fix", { json })));
  server.registerTool("verify_journey", {
    title: "Run a saved journey",
    description: "Execute a named saved journey with the project's encrypted, consented test account inside an isolated browser; no payment, deletion or non-login writes.",
    inputSchema: { project: projectArg, journey: z.string().min(1).max(80) },
    annotations: { ...READ, openWorldHint: true },
  }, wrap("return", async ({ project, journey }) => projectRequest(project, "POST", "/journeys/verify", { json: { journey } })));
  const approvalSchema = z.object({ expectedRevision: z.number().int().nonnegative(), planDigest: z.string().regex(/^[a-f0-9]{64}$/), approve: z.literal(true), acknowledgeDnsOnlyUndo: z.boolean().optional() }).strict();
  server.registerTool("import", {
    title: "Import an existing app",
    description: "Import an app from another host without deleting the source host. action=scan (default) sends `request` (the documented provider/config/source mappings) and stores an encrypted, names-only plan; credentials are accepted only in `request` and are never returned. action=approve/deploy/copy/sync runs the next phase and requires `id` plus a fresh revision-bound approval. Progress is reported by import_status; DNS changes are made by import_cutover and import_undo.",
    inputSchema: { project: projectArg, action: z.enum(["scan", "approve", "deploy", "copy", "sync"]).default("scan"), id: z.string().uuid().optional(), request: z.record(z.string(), z.unknown()).optional(), approval: approvalSchema.optional() },
    annotations: { ...WRITE, openWorldHint: true },
  }, wrap("plan", async ({ project, action, id, request, approval }) => {
    if (action === "scan") {
      if (!(await deps.getClient()).apiUrl.startsWith("https://")) throw new Error("Import credentials require HTTPS");
      return projectRequest(project, "POST", "/imports", { json: request ?? { source: "auto" } });
    }
    if (!id) throw new Error("Scan first and provide its import ID");
    if (!approval) throw new Error("This action requires explicit revision-bound approval");
    return projectRequest(project, "POST", `/imports/${encodeURIComponent(id)}/${action}`, { json: approval });
  }));
  server.registerTool("import_status", {
    title: "Import status",
    description: "Return the current state of an import: plan, revision, digest, phase results and any running operation (absent when finished).",
    inputSchema: { project: projectArg, id: z.string().uuid() },
    annotations: READ,
  }, wrap("plan", async ({ project, id }) => projectRequest(project, "GET", `/imports/${encodeURIComponent(id)}`)));
  for (const action of ["cutover", "undo"] as const) server.registerTool(`import_${action}`, {
    title: action === "cutover" ? "Approve import DNS cutover" : "Undo import DNS cutover",
    description: action === "cutover" ? "Owner-approved traffic cutover after verified preview, data synchronization and writer fencing. Does not delete the source host." : "Owner-approved DNS-only undo within seven days. Requires acknowledgeDnsOnlyUndo: true, confirming that application writes are not automatically reversed.",
    inputSchema: { project: projectArg, id: z.string().uuid(), ...approvalSchema.shape },
    annotations: { ...WRITE, openWorldHint: true },
  }, wrap("plan", async ({ project, id, ...approval }) => projectRequest(project, "POST", `/imports/${encodeURIComponent(id)}/${action}`, { json: approval })));

  server.registerTool(
    "deploy",
    {
      title: "Deploy a local folder",
      description:
        "Pack the project folder at `path` (respects .gitignore; .env files are never uploaded; only files changed since the last deploy are uploaded), upload it and deploy every service it contains " +
        "(frontend, API, workers) plus the Postgres/Redis/object storage the code needs. Waits until done and returns a DeployResult JSON: " +
        "`status` is `live` (see `urls`), `failed` (with `error.cause`, `error.file` and `error.fix`; a redeploy rebuilds only changed services) " +
        "or `needs_input` (missing secrets listed in `error.missing` / `plan.missingSecrets`, which `env_set` stores). " +
        "`dry_run: true` previews the detected services, data, env wiring and assumptions without deploying. " +
        "`env` sets plain env vars/secrets for this deploy (values are never echoed back).",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path (or relative to the server's working directory) of the project root to deploy."),
        project: projectArg,
        dry_run: z.boolean().optional().describe("Only detect and return the deploy plan; nothing is built or changed."),
        env: z.record(z.string(), z.string()).optional().describe("Env vars to set before deploying, e.g. {\"STRIPE_SECRET_KEY\": \"...\"}."),
        clean: z.boolean().optional().describe("Rebuild every service from scratch without build/dependency caches. Slower; use when a cached dependency looks stale or broken."),
        verify: z.boolean().optional().describe("False skips functional checks, but mandatory client-secret scanning always runs."),
      },
      annotations: { ...WRITE, openWorldHint: true },
    },
    wrap("upload", async (args: { path: string; project?: string; dry_run?: boolean; env?: Record<string, string>; clean?: boolean; verify?: boolean }, extra) => {
      const client = await deps.getClient();
      const progressToken = extra?._meta?.progressToken;
      let step = 0;
      const outcome = await runDeploy(client, {
        dir: resolve(cwd(), args.path),
        project: args.project,
        dryRun: args.dry_run,
        env: args.env,
        clean: args.clean,
        verify: args.verify,
        wait: true,
        pollIntervalMs: deps.pollIntervalMs,
        sleep: deps.sleep,
        onProgress: (ev) => {
          if (progressToken === undefined || (ev.type !== "stage" && ev.type !== "uploading")) return;
          const message = ev.type === "stage" ? `stage: ${ev.stage}` : `uploading to ${ev.project}`;
          void extra
            .sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++step, message } } as never)
            .catch(() => undefined);
        },
      });
      if (outcome.kind === "plan") return ok({ status: "dry_run", project: outcome.project.slug, plan: outcome.plan, files: outcome.pack.files.length, bytes: outcome.pack.bytes });
      if (outcome.kind === "started") return ok({ status: "started", project: outcome.project.slug, deploymentId: outcome.deploymentId });
      const result = outcome.result;
      return { ...ok(result), isError: result.status === "failed" };
    }),
  );

  server.registerTool(
    "status",
    {
      title: "Project status",
      description: "Current state of every service (status, URL, framework, release), data service (Postgres/Redis/R2 usage) and the last deployment of a project.",
      inputSchema: { project: projectArg },
      annotations: READ,
    },
    wrap("return", async (args: { project?: string }) => {
      const client = await deps.getClient();
      return ok(await client.getProject(await slugFor(args.project)));
    }),
  );

  server.registerTool(
    "logs",
    {
      title: "Logs",
      description:
        "Runtime logs of a project (summarised by default; filter by service, time window and level), or the build/deploy log of one deployment when `deployment_id` is given. " +
        "Failed deploys also return a structured error with cause and fix.",
      inputSchema: {
        project: projectArg,
        service: z.string().optional().describe("Service name, e.g. \"api\"."),
        since: z.string().optional().describe("Time window such as \"15m\", \"2h\" or an ISO timestamp."),
        level: z.enum(["debug", "info", "warn", "error"]).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        summary: z.boolean().optional().describe("Default true: grouped summary. false = raw lines."),
        deployment_id: z.string().optional().describe("Return the build/deploy log of this deployment instead of runtime logs."),
      },
      annotations: READ,
    },
    wrap("return", async (args: { project?: string; service?: string; since?: string; level?: string; limit?: number; summary?: boolean; deployment_id?: string }) => {
      const client = await deps.getClient();
      if (args.deployment_id) return ok(await client.getDeploymentLogs(args.deployment_id));
      return ok(await client.projectLogs(await slugFor(args.project), args));
    }),
  );

  server.registerTool(
    "env_set",
    {
      title: "Set or remove env vars / secrets",
      description:
        "Set (`vars`) and/or remove (`remove`) environment variables for a project, optionally for a single service. Running services restart with the new values (no rebuild). " +
        "Used after a deploy returns `needs_input`. Values are stored encrypted and are never echoed back; only the key names are returned.",
      inputSchema: {
        project: projectArg,
        vars: z.record(z.string(), z.string()).optional().describe("Map of KEY to value."),
        remove: z.array(z.string()).optional().describe("Keys to delete."),
        service: z.string().optional().describe("Limit to one service; default applies to all services."),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    wrap("env", async (args: { project?: string; vars?: Record<string, string>; remove?: string[]; service?: string }) => {
      const client = await deps.getClient();
      const slug = await slugFor(args.project);
      const setKeys = Object.keys(args.vars ?? {});
      if (setKeys.length === 0 && !(args.remove?.length)) {
        return fail({ status: "failed", stage: "env", code: "invalid_arguments", cause: "Nothing to do: pass `vars` and/or `remove`.", fix: "Call env_set with vars: {KEY: value} or remove: [\"KEY\"].", retryable: false });
      }
      for (const k of setKeys) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          return fail({ status: "failed", stage: "env", code: "invalid_env_key", cause: `"${k}" is not a valid env var name.`, fix: "Use letters, digits and underscores, not starting with a digit.", retryable: false });
        }
      }
      if (setKeys.length) await client.envSet(slug, args.vars ?? {}, args.service);
      if (args.remove?.length) await client.envRemove(slug, args.remove, args.service);
      return ok({ project: slug, service: args.service ?? null, set: setKeys, removed: args.remove ?? [], note: "Services restart with the new values; no rebuild needed." });
    }),
  );

  server.registerTool(
    "rollback",
    {
      title: "Roll back",
      description: "Point traffic back at a previous release in seconds. Without `release_id`, rolls back to the release before the current one.",
      inputSchema: { project: projectArg, release_id: z.string().optional() },
      annotations: WRITE,
    },
    wrap("rollback", async (args: { project?: string; release_id?: string }) => {
      const client = await deps.getClient();
      return ok(await client.rollback(await slugFor(args.project), args.release_id));
    }),
  );

  server.registerTool(
    "db",
    {
      title: "Read the database",
      description:
        "Read the project's Postgres. action `query`: run read-only SQL (5 s timeout, max 500 rows). " +
        "action `tables`: list tables with row counts and sizes. Temporary credentials come from db_connection; dumps from db_export.",
      inputSchema: {
        project: projectArg,
        action: z.enum(["query", "tables"]),
        sql: z.string().optional().describe("Required for action=query."),
      },
      annotations: READ,
    },
    wrap("db", async (args: { project?: string; action: "query" | "tables"; sql?: string }) => {
      const client = await deps.getClient();
      const slug = await slugFor(args.project);
      if (args.action === "tables") return projectRequest(slug, "GET", "/db/tables");
      if (!args.sql) return fail({ status: "failed", stage: "db", code: "invalid_arguments", cause: "action=query needs `sql`.", fix: "Pass sql, e.g. \"select count(*) from users\".", retryable: false });
      return ok(await client.dbQuery(slug, args.sql));
    }),
  );

  server.registerTool(
    "db_connection",
    {
      title: "Create a database connection string",
      description: "Create temporary Postgres credentials for the project (a new login valid 1 hour, with the app's database permissions) and return the connection string. The result is a credential.",
      inputSchema: { project: projectArg },
      annotations: WRITE,
    },
    wrap("db", async (args: { project?: string }) => {
      const client = await deps.getClient();
      return ok(await client.dbConnection(await slugFor(args.project)), { redact: false });
    }),
  );

  server.registerTool(
    "db_export",
    {
      title: "Export the database to a file",
      description: "Download a pg_dump (custom format) of the project's Postgres and write it to `output` on this machine (default ./<project>.dump; an existing file at that path is overwritten). Returns the path and size.",
      inputSchema: {
        project: projectArg,
        output: z.string().optional().describe("File path to write, e.g. ./backup.dump."),
      },
      annotations: WRITE,
    },
    wrap("db", async (args: { project?: string; output?: string }) => {
      const client = await deps.getClient();
      const slug = await slugFor(args.project);
      const out = resolve(cwd(), args.output ?? `${slug}.dump`);
      const bytes = await downloadTo(await client.dbExport(slug), out);
      return ok({ project: slug, path: out, bytes });
    }),
  );

  server.registerTool(
    "domain_add",
    {
      title: "Add custom domain",
      description: "Attach a custom domain (e.g. app.example.com) to a project's service. Returns the exact DNS record to create at the domain's DNS provider; TLS is issued automatically once DNS resolves.",
      inputSchema: {
        project: projectArg,
        hostname: z.string().min(3).describe("Fully qualified hostname, e.g. \"www.example.com\"."),
        service: z.string().optional().describe("Service to route to; default is the project's primary public service."),
      },
      annotations: WRITE,
    },
    wrap("domain", async (args: { project?: string; hostname: string; service?: string }) => {
      const client = await deps.getClient();
      return ok(await client.domainAdd(await slugFor(args.project), args.hostname.trim().toLowerCase(), args.service));
    }),
  );

  server.registerTool(
    "destroy",
    {
      title: "Destroy project",
      description:
        "Permanently delete a project, all its services AND its data (databases, files). Two steps: a call without `confirm_token` deletes nothing and returns one " +
        "(valid about 10 minutes); a call with that `confirm_token` performs the deletion.",
      inputSchema: {
        project: z.string().regex(SLUG_RE).describe("Project slug to delete (required, never inferred)."),
        confirm_token: z.string().optional(),
      },
      annotations: WRITE,
    },
    wrap("return", async (args: { project: string; confirm_token?: string }) => {
      const client = await deps.getClient();
      const res = await client.destroy(args.project, args.confirm_token);
      if (!args.confirm_token) {
        return ok({
          ...res,
          project: args.project,
          next: "Nothing has been deleted yet. Calling destroy again with this confirm_token permanently deletes the project and all its data.",
        });
      }
      return ok(res ?? { project: args.project, destroyed: true });
    }),
  );

  server.registerTool(
    "upgrade",
    {
      title: "Upgrade plan",
      description: "Create a checkout link for upgrading the user's Rivtor plan (hobby, pro or team). No charge is made by this tool; payment is completed in the browser.",
      inputSchema: {
        plan: z.enum(["hobby", "pro", "team"]).optional().describe("Default hobby."),
        interval: z.enum(["month", "year"]).optional().describe("Default month."),
      },
      annotations: { ...WRITE, openWorldHint: true },
    },
    wrap("limits", async (args: { plan?: string; interval?: string }) => {
      const client = await deps.getClient();
      return ok(await client.checkout({ plan: args.plan ?? "hobby", interval: args.interval ?? "month" }));
    }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List the user's Rivtor projects with their URLs and status.",
      inputSchema: {},
      annotations: READ,
    },
    wrap("return", async () => {
      const client = await deps.getClient();
      return ok(await client.listProjects());
    }),
  );

  return server;
}

/** Streams a fetch Response body to a file; returns bytes written. */
export async function downloadTo(res: Response, path: string): Promise<number> {
  if (!res.body) throw new Error("Empty response body");
  await mkdir(dirname(path), { recursive: true });
  let bytes = 0;
  const counter = Readable.fromWeb(res.body as never);
  counter.on("data", (chunk: Buffer) => (bytes += chunk.length));
  await pipeline(counter, createWriteStream(path, { mode: 0o600 }));
  return bytes;
}
