import type { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { CliError, action, getClient, printJson, projectSlug } from "../context.js";
import { table } from "../output.js";
import { defaultEnvFile, ensureGitignore, writeEnvPull } from "../envpull.js";
import { DEFAULT_DB_PORT } from "../tunnel.js";

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseAssignments(pairs: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(`Expected KEY=VALUE, got "${pair.length > 40 ? pair.slice(0, 40) + "…" : pair}".`);
    const key = pair.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) throw new CliError(`"${key}" is not a valid env var name (letters, digits, underscores; not starting with a digit).`);
    vars[key] = pair.slice(eq + 1);
  }
  return vars;
}

export function registerEnv(program: Command): void {
  const env = program.command("env").description("Manage env vars and secrets (restart, no rebuild)");

  env
    .command("set")
    .description("Set env vars: rivtor env set KEY=VALUE [KEY2=VALUE2 ...]")
    .argument("<pairs...>", "KEY=VALUE pairs")
    .option("-s, --service <name>", "only this service")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (pairs: string[], opts: { service?: string; project?: string; json?: boolean }) => {
        const vars = parseAssignments(pairs);
        const slug = await projectSlug(opts.project);
        await (await getClient()).envSet(slug, vars, opts.service);
        const keys = Object.keys(vars);
        if (opts.json) return printJson({ project: slug, service: opts.service ?? null, set: keys });
        process.stdout.write(`${pc.green("✓")} Set ${keys.map((k) => pc.bold(k)).join(", ")} on ${pc.bold(slug)}${opts.service ? ` (${opts.service})` : ""}; services are restarting\n`);
      }),
    );

  env
    .command("rm")
    .alias("unset")
    .description("Remove env vars")
    .argument("<keys...>", "keys to remove")
    .option("-s, --service <name>", "only this service")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (keys: string[], opts: { service?: string; project?: string; json?: boolean }) => {
        const slug = await projectSlug(opts.project);
        await (await getClient()).envRemove(slug, keys, opts.service);
        if (opts.json) return printJson({ project: slug, service: opts.service ?? null, removed: keys });
        process.stdout.write(`${pc.green("✓")} Removed ${keys.map((k) => pc.bold(k)).join(", ")} from ${pc.bold(slug)}\n`);
      }),
    );

  env
    .command("ls")
    .alias("list")
    .description("List env vars (values masked)")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (opts: { project?: string; json?: boolean }) => {
        const slug = await projectSlug(opts.project);
        const res = await (await getClient()).envList(slug);
        if (opts.json) return printJson(res);
        const rows: Record<string, unknown>[] = Array.isArray(res)
          ? res
          : Array.isArray((res as Record<string, unknown>)?.vars)
            ? ((res as Record<string, unknown>).vars as Record<string, unknown>[])
            : Array.isArray((res as Record<string, unknown>)?.env)
              ? ((res as Record<string, unknown>).env as Record<string, unknown>[])
              : [];
        if (rows.length === 0) {
          process.stdout.write("No env vars set.\n");
          return;
        }
        const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
        process.stdout.write(
          table(rows.map((r) => [pc.bold(s(r.key)), pc.dim(s(r.service ?? "all")), pc.dim(s(r.source)), s(r.valuePreview ?? r.value_preview ?? r.masked ?? "••••")])) + "\n",
        );
      }),
    );

  env
    .command("pull")
    .description("Write the project's env vars to .env.local (Next.js/Vite) or .env; the database is reached through `rivtor db connect`")
    .option("-p, --project <slug>", "project slug")
    .option("-f, --file <path>", "file to write (default .env.local for Next.js/Vite apps, else .env)")
    .option("--local", "local-safe set (default): DATABASE_URL points at localhost through `rivtor db connect`")
    .option("--production", "production values (data-service passwords and secrets left out unless --include-secrets)")
    .option("--include-secrets", "also write payment/provider secrets")
    .option("-s, --service <name>", "values for one service")
    .option("--port <port>", "local port of `rivtor db connect`", String(DEFAULT_DB_PORT))
    .option("--force", "replace an existing file (nothing is merged)")
    .option("--json", "print JSON (counts and names, never values)")
    .action(
      action(async (opts: { project?: string; file?: string; local?: boolean; production?: boolean; includeSecrets?: boolean; service?: string; port: string; force?: boolean; json?: boolean }) => {
        if (opts.local && opts.production) throw new CliError("Pick one of --local or --production.");
        const port = Number(opts.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CliError("--port must be 1024-65535.");
        const slug = await projectSlug(opts.project);
        const cwd = process.cwd();
        const rel = opts.file ?? (await defaultEnvFile(cwd));
        const file = resolve(cwd, rel);
        // Checked before the request, so a refused write doesn't create a database login.
        if (existsSync(file) && !opts.force) throw new CliError(`${rel} already exists. Re-run with --force to replace it (its contents are not merged).`);
        const set = opts.production ? "production" : "local";
        const res = await (await getClient()).envExport(slug, { set, includeSecrets: !!opts.includeSecrets, service: opts.service, port });
        await writeEnvPull(file, res, true);
        const gitignored = await ensureGitignore(cwd);
        const count = (reason: string) => res.omitted.filter((o) => o.reason === reason).map((o) => o.key);
        const summary = {
          project: res.project,
          set: res.set,
          file: rel,
          written: Object.keys(res.vars).length,
          omitted: res.omitted,
          database: res.database ?? null,
          gitignoreUpdated: gitignored,
        };
        if (opts.json) return printJson(summary);
        process.stdout.write(`${pc.green("✓")} Wrote ${summary.written} var${summary.written === 1 ? "" : "s"} to ${pc.bold(rel)} ${pc.dim(`(${res.set} set for ${res.project})`)}\n`);
        const secrets = count("sensitive");
        if (secrets.length) process.stdout.write(pc.dim(`  ${secrets.length} secret${secrets.length === 1 ? "" : "s"} left out (${secrets.join(", ")}); add --include-secrets to write them\n`));
        const unreachable = count("not_reachable_locally");
        if (unreachable.length) process.stdout.write(pc.dim(`  not reachable from your machine, left out: ${unreachable.join(", ")}\n`));
        const differs = count("differs_per_service");
        if (differs.length) process.stdout.write(pc.dim(`  differs per service, left out: ${differs.join(", ")} (use --service <name>)\n`));
        if (res.database) process.stdout.write(`  DATABASE_URL points at localhost:${res.database.port}: run ${pc.bold(`rivtor db connect${opts.project ? ` -p ${slug}` : ""}`)} in another terminal ${pc.dim(`(login expires ${res.database.expiresAt})`)}\n`);
        if (gitignored) process.stdout.write(pc.dim("  added .env* to .gitignore\n"));
      }),
    );
}
