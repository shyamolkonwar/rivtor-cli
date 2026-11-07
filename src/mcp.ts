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
        fix: `Ask the user to run \`npx rivtor login\` in a terminal (token from ${TOKENS_URL}), or add RIVTOR_TOKEN to this MCP server's env config, then retry.`,
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
  "domain_add",
  "destroy",
  "upgrade",
  "list_projects",
] as const;

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "rivtor", version: deps.version },
    {
      instructions:
        "Rivtor deploys any repo (frontend + backend + Postgres/Redis/storage) with one `deploy` call and returns live URLs. " +
        "Self-healing loop: call `deploy` → if status is `failed`, read error.cause/error.file/error.fix, edit the code, call `deploy` again (only changed services rebuild). " +
        "If status is `needs_input`, ask the user for each missing secret once, store them with `env_set`, then call `deploy` again. Never print secret values back to the user.",
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

  server.registerTool(
    "deploy",
    {
      title: "Deploy a local folder",
      description:
        "Pack the project folder at `path` (respects .gitignore; .env files are never uploaded), upload it and deploy every service it contains " +
        "(frontend, API, workers) plus the Postgres/Redis/object storage the code needs. Waits until done and returns a DeployResult JSON: " +
        "`status` is `live` (see `urls`), `failed` (fix the code using `error.cause`, `error.file` and `error.fix`, then call deploy again) " +
        "or `needs_input` (missing secrets listed in `error.missing` / `plan.missingSecrets`: ask the user, call `env_set`, then deploy again). " +
        "Use `dry_run: true` first to preview the detected services, data, env wiring and assumptions without deploying. " +
        "`env` sets plain env vars/secrets for this deploy (values are never echoed back).",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path (or relative to the server's working directory) of the project root to deploy."),
        project: projectArg,
        dry_run: z.boolean().optional().describe("Only detect and return the deploy plan; nothing is built or changed."),
        env: z.record(z.string()).optional().describe("Env vars to set before deploying, e.g. {\"STRIPE_SECRET_KEY\": \"...\"}."),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap("upload", async (args: { path: string; project?: string; dry_run?: boolean; env?: Record<string, string> }, extra) => {
      const client = await deps.getClient();
      const progressToken = extra?._meta?.progressToken;
      let step = 0;
      const outcome = await runDeploy(client, {
        dir: resolve(cwd(), args.path),
        project: args.project,
        dryRun: args.dry_run,
        env: args.env,
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
      annotations: { readOnlyHint: true },
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
        "You rarely need this: failed deploys already return a structured error with cause and fix.",
      inputSchema: {
        project: projectArg,
        service: z.string().optional().describe("Service name, e.g. \"api\"."),
        since: z.string().optional().describe("Time window such as \"15m\", \"2h\" or an ISO timestamp."),
        level: z.enum(["debug", "info", "warn", "error"]).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        summary: z.boolean().optional().describe("Default true: grouped summary. false = raw lines."),
        deployment_id: z.string().optional().describe("Return the build/deploy log of this deployment instead of runtime logs."),
      },
      annotations: { readOnlyHint: true },
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
        "Use this after a deploy returns `needs_input`. Values are stored encrypted and are never echoed back; only the key names are returned.",
      inputSchema: {
        project: projectArg,
        vars: z.record(z.string()).optional().describe("Map of KEY to value."),
        remove: z.array(z.string()).optional().describe("Keys to delete."),
        service: z.string().optional().describe("Limit to one service; default applies to all services."),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
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
      annotations: { destructiveHint: false },
    },
    wrap("rollback", async (args: { project?: string; release_id?: string }) => {
      const client = await deps.getClient();
      return ok(await client.rollback(await slugFor(args.project), args.release_id));
    }),
  );

  server.registerTool(
    "db",
    {
      title: "Database",
      description:
        "Work with the project's Postgres. action `query`: run read-only SQL (5 s timeout, max 500 rows). " +
        "action `connection`: create a temporary connection string valid for 1 hour (give it to the user only if they asked). " +
        "action `export`: download a pg_dump (custom format) to `output` on this machine.",
      inputSchema: {
        project: projectArg,
        action: z.enum(["query", "connection", "export"]),
        sql: z.string().optional().describe("Required for action=query."),
        output: z.string().optional().describe("File path for action=export, e.g. ./backup.dump."),
      },
    },
    wrap("db", async (args: { project?: string; action: "query" | "connection" | "export"; sql?: string; output?: string }) => {
      const client = await deps.getClient();
      const slug = await slugFor(args.project);
      if (args.action === "query") {
        if (!args.sql) return fail({ status: "failed", stage: "db", code: "invalid_arguments", cause: "action=query needs `sql`.", fix: "Pass sql, e.g. \"select count(*) from users\".", retryable: false });
        return ok(await client.dbQuery(slug, args.sql));
      }
      if (args.action === "connection") return ok(await client.dbConnection(slug), { redact: false });
      const out = resolve(cwd(), args.output ?? `${slug}.dump`);
      const bytes = await downloadTo(await client.dbExport(slug), out);
      return ok({ project: slug, path: out, bytes });
    }),
  );

  server.registerTool(
    "domain_add",
    {
      title: "Add custom domain",
      description: "Attach a custom domain (e.g. app.example.com) to a project's service. Returns the exact DNS record the user must create at their DNS provider; TLS is issued automatically once DNS resolves.",
      inputSchema: {
        project: projectArg,
        hostname: z.string().min(3).describe("Fully qualified hostname, e.g. \"www.example.com\"."),
        service: z.string().optional().describe("Service to route to; default is the project's primary public service."),
      },
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
        "Permanently delete a project, all its services AND its data (databases, files). Two steps: call without `confirm_token` to get one, " +
        "then ask the user to explicitly confirm deleting the named project, and only then call again with the `confirm_token`. Never do the second call without the user's explicit approval.",
      inputSchema: {
        project: z.string().regex(SLUG_RE).describe("Project slug to delete (required, never inferred)."),
        confirm_token: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    wrap("return", async (args: { project: string; confirm_token?: string }) => {
      const client = await deps.getClient();
      const res = await client.destroy(args.project, args.confirm_token);
      if (!args.confirm_token) {
        return ok({
          ...res,
          project: args.project,
          next: "Ask the user to confirm deleting this project and all its data. If they agree, call destroy again with this confirm_token.",
        });
      }
      return ok(res ?? { project: args.project, destroyed: true });
    }),
  );

  server.registerTool(
    "upgrade",
    {
      title: "Upgrade plan",
      description: "Return a checkout link to upgrade the user's Rivtor plan (hobby, pro or team). Show the link to the user; they complete payment in the browser.",
      inputSchema: {
        plan: z.enum(["hobby", "pro", "team"]).optional().describe("Default hobby."),
        interval: z.enum(["month", "year"]).optional().describe("Default month."),
      },
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
      annotations: { readOnlyHint: true },
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
