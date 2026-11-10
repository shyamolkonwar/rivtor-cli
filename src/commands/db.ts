import type { Command } from "commander";
import { resolve } from "node:path";
import pc from "picocolors";
import { CliError, action, cliVersion, getClient, printJson, projectSlug } from "../context.js";
import { downloadTo } from "../mcp.js";
import { formatBytes, table } from "../output.js";
import { DEFAULT_DB_PORT, localConnectionString, startDbTunnel, webSocketAvailable } from "../tunnel.js";

function cell(v: unknown): string {
  if (v === null || v === undefined) return pc.dim("null");
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

export function registerDb(program: Command): void {
  const db = program.command("db").description("Query, connect to, tunnel to, export or restore the project's Postgres");

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

  db
    .command("snapshots")
    .description("List the snapshots taken before migrations (restore one with db restore)")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (opts: { project?: string; json?: boolean }) => {
        const res = (await (await getClient()).dbSnapshots(await projectSlug(opts.project))) as { snapshots?: Array<Record<string, unknown>> };
        if (opts.json) return printJson(res);
        const rows = res?.snapshots ?? [];
        if (!rows.length) {
          process.stdout.write(pc.dim("(no snapshots yet: one is taken before every migration)\n"));
          return;
        }
        process.stdout.write(
          table([
            ["id", "taken", "kind", "size"].map((c) => pc.bold(c)),
            ...rows.map((s) => [String(s.id), String(s.takenAt), s.restorable ? String(s.kind) : pc.dim(`${String(s.kind)} (not restorable here)`), formatBytes(Number(s.sizeBytes) || 0)]),
          ], "") + "\n",
        );
      }),
    );

  db
    .command("restore")
    .description("Overwrite the database with a snapshot (asks the user to approve first)")
    .option("-s, --snapshot <id>", "snapshot id from rivtor db snapshots")
    .option("--at <timestamp>", "restore the newest snapshot taken at or before this ISO time")
    .option("--approval-token <token>", "token shown on the approval page")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (opts: { snapshot?: string; at?: string; approvalToken?: string; project?: string; json?: boolean }) => {
        if (!opts.snapshot && !opts.at) throw new CliError("Pass --snapshot <id> or --at <timestamp> (list them with rivtor db snapshots).");
        const slug = await projectSlug(opts.project);
        const res = (await (await getClient()).dbRestore(slug, { snapshotId: opts.snapshot, timestamp: opts.at, approvalToken: opts.approvalToken })) as Record<string, unknown>;
        if (opts.json) return printJson(res);
        const snap = (res.restored ?? {}) as Record<string, unknown>;
        process.stdout.write(`${pc.green("✓")} Restored ${pc.bold(slug)} to snapshot ${pc.bold(String(snap.id))} ${pc.dim(`(${String(snap.takenAt)})`)}\n`);
        if (res.note) process.stdout.write(pc.dim(`  ${String(res.note)}\n`));
      }),
    );

  db
    .command("connect")
    .description(`Open an authenticated tunnel to the project's Postgres on localhost (default port ${DEFAULT_DB_PORT})`)
    .option("-p, --project <slug>", "project slug")
    .option("--port <port>", "local port", String(DEFAULT_DB_PORT))
    .option("--json", "print JSON, then keep the tunnel open")
    .action(
      action(async (opts: { project?: string; port: string; json?: boolean }) => {
        if (!webSocketAvailable()) throw new CliError(`rivtor db connect needs Node.js 22 or newer (you have ${process.versions.node}).`);
        const port = Number(opts.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CliError("--port must be 1024-65535.");
        const slug = await projectSlug(opts.project);
        const client = await getClient();
        // Also checks the token, its scope and the project before anything listens.
        const res = (await client.dbConnection(slug)) as Record<string, unknown>;
        const conn = res?.url ?? res?.connectionString;
        if (typeof conn !== "string") throw new CliError("The API did not return a connection string.");
        const local = localConnectionString(conn, port);
        const server = await startDbTunnel({
          apiUrl: client.apiUrl,
          token: client.token!,
          slug,
          port,
          userAgent: `rivtor-cli/${await cliVersion()} node/${process.versions.node}`,
          onError: (m) => process.stderr.write(pc.red(`✗ ${m}\n`)),
        }).catch((err: NodeJS.ErrnoException) => {
          throw new CliError(err.code === "EADDRINUSE" ? `Port ${port} is in use (another \`rivtor db connect\`?). Pick another with --port.` : err.message);
        });
        if (opts.json) printJson({ project: slug, host: "localhost", port, url: local, expiresAt: res.expiresAt ?? null });
        else {
          process.stdout.write(`${pc.green("✓")} Tunnel to ${pc.bold(slug)}'s Postgres on ${pc.bold(`localhost:${port}`)}\n`);
          process.stdout.write(`  ${local}\n`);
          process.stdout.write(pc.dim(`  temporary login${res.expiresAt ? `, expires ${String(res.expiresAt)}` : ""}; \`rivtor env pull\` writes one into your env file. Ctrl+C to stop.\n`));
        }
        await new Promise<void>((done) => {
          const stop = () => server.close(() => done());
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      }),
    );
}
