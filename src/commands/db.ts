import type { Command } from "commander";
import { resolve } from "node:path";
import pc from "picocolors";
import { CliError, action, getClient, printJson, projectSlug } from "../context.js";
import { downloadTo } from "../mcp.js";
import { formatBytes, table } from "../output.js";

function cell(v: unknown): string {
  if (v === null || v === undefined) return pc.dim("null");
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

export function registerDb(program: Command): void {
  const db = program.command("db").description("Query, connect to or export the project's Postgres");

  db
    .command("query")
    .description('Run read-only SQL: rivtor db query "select * from users limit 5"')
    .argument("<sql>", "SQL statement")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (sql: string, opts: { project?: string; json?: boolean }) => {
        const res = (await (await getClient()).dbQuery(await projectSlug(opts.project), sql)) as Record<string, unknown>;
        if (opts.json) return printJson(res);
        const rows = (Array.isArray(res?.rows) ? res.rows : Array.isArray(res) ? res : []) as unknown[];
        if (rows.length === 0) {
          process.stdout.write(pc.dim("(0 rows)\n"));
          return;
        }
        let cols: string[] = [];
        if (Array.isArray(res.fields)) cols = (res.fields as Array<{ name?: string } | string>).map((f) => (typeof f === "string" ? f : String(f.name)));
        else if (Array.isArray(res.columns)) cols = (res.columns as Array<{ name?: string } | string>).map((f) => (typeof f === "string" ? f : String(f.name)));
        else if (rows[0] && typeof rows[0] === "object" && !Array.isArray(rows[0])) cols = Object.keys(rows[0] as object);
        const body = rows.map((r) => (Array.isArray(r) ? r.map(cell) : cols.map((c) => cell((r as Record<string, unknown>)[c]))));
        process.stdout.write(table([cols.map((c) => pc.bold(c)), ...body], "") + "\n");
        process.stdout.write(pc.dim(`(${rows.length} row${rows.length === 1 ? "" : "s"}${res.truncated ? ", truncated" : ""})\n`));
      }),
    );

  db
    .command("url")
    .description("Create a temporary connection string (valid ~1h)")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (opts: { project?: string; json?: boolean }) => {
        const res = (await (await getClient()).dbConnection(await projectSlug(opts.project))) as Record<string, unknown>;
        if (opts.json) return printJson(res);
        const conn = res?.url ?? res?.connectionString ?? res?.connection_string ?? res?.databaseUrl;
        if (typeof conn !== "string") throw new CliError("The API did not return a connection string.");
        process.stdout.write(conn + "\n");
        const exp = res.expiresAt ?? res.expires_at;
        if (exp) process.stderr.write(pc.dim(`expires ${String(exp)}\n`));
      }),
    );

  db
    .command("export")
    .description("Download a pg_dump (custom format)")
    .requiredOption("-o, --output <file>", "output file, e.g. backup.dump")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (opts: { output: string; project?: string; json?: boolean }) => {
        const slug = await projectSlug(opts.project);
        const out = resolve(opts.output);
        const bytes = await downloadTo(await (await getClient()).dbExport(slug), out);
        if (opts.json) return printJson({ project: slug, path: out, bytes });
        process.stdout.write(`${pc.green("✓")} Exported ${pc.bold(slug)} to ${out} ${pc.dim(`(${formatBytes(bytes)})`)}\n`);
        process.stdout.write(pc.dim(`  restore with: pg_restore --no-owner -d <database-url> ${opts.output}\n`));
      }),
    );
}
