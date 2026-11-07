import type { Command } from "commander";
import pc from "picocolors";
import { CliError, action, getClient, printJson, projectSlug } from "../context.js";
import { table } from "../output.js";

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
}
