import type { AgentError } from "./shared.js";
import { readFile } from "node:fs/promises";
import pc from "picocolors";
import { ApiClient, RivtorApiError } from "./api.js";
import { resolveConfig } from "./config.js";
import { EXIT } from "./constants.js";
import { formatAgentError } from "./output.js";
import { PackError } from "./pack.js";
import { ProjectConfigError, resolveProject } from "./project.js";

let cachedVersion: string | null = null;
export async function cliVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export async function getClient(): Promise<ApiClient> {
  const cfg = await resolveConfig();
  return new ApiClient({ apiUrl: cfg.apiUrl, token: cfg.token, userAgent: `rivtor-cli/${await cliVersion()} node/${process.versions.node}` });
}

/** `[project]` argument / --project flag, else rivtor.json in cwd, else cwd folder name. */
export async function projectSlug(explicit?: string): Promise<string> {
  return (await resolveProject(process.cwd(), explicit)).slug;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.FAILED,
  ) {
    super(message);
  }
}

export function toAgentError(err: unknown): AgentError | null {
  if (err instanceof RivtorApiError) return err.agentError;
  if (err instanceof PackError) return { status: "failed", stage: "upload", code: err.code, cause: err.message, fix: err.fix, retryable: false };
  if (err instanceof ProjectConfigError) return { status: "failed", stage: "upload", code: "invalid_project", cause: err.message, fix: "Fix the project slug (or rivtor.json), then retry.", retryable: false };
  return null;
}

/** Wraps a command action: consistent error printing and exit codes. */
export function action<A extends unknown[]>(fn: (...args: A) => Promise<number | void>) {
  return async (...args: A): Promise<void> => {
    const cmd = args[args.length - 1] as { optsWithGlobals?: () => Record<string, unknown> } | undefined;
    const json = Boolean(cmd?.optsWithGlobals?.().json);
    try {
      const code = await fn(...args);
      process.exitCode = code ?? EXIT.OK;
    } catch (err) {
      const agentError = toAgentError(err);
      if (agentError) {
        if (json) process.stdout.write(JSON.stringify(agentError, null, 2) + "\n");
        else process.stderr.write(formatAgentError(agentError) + "\n");
        process.exitCode = agentError.status === "needs_input" ? EXIT.NEEDS_INPUT : EXIT.FAILED;
        return;
      }
      if ((err as { code?: string })?.code === "ABORT") {
        process.stderr.write(pc.dim("Cancelled.\n"));
        process.exitCode = EXIT.FAILED;
        return;
      }
      const message = (err as Error)?.message ?? String(err);
      if (json) process.stdout.write(JSON.stringify({ status: "failed", code: "cli_error", cause: message }, null, 2) + "\n");
      else process.stderr.write(pc.red(`✗ ${message}\n`));
      process.exitCode = err instanceof CliError ? err.exitCode : EXIT.FAILED;
    }
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
