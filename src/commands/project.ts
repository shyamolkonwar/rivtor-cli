import type { ServiceStatus } from "../shared.js";
import type { Command } from "commander";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { normalizeLogs } from "../api.js";
import { EXIT } from "../constants.js";
import { CliError, action, getClient, printJson, projectSlug } from "../context.js";
import { formatBytes, formatServices, statusColor, table, url } from "../output.js";
import { ask } from "../prompt.js";

function asArray(v: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === "object") {
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (Array.isArray(x)) return x as Record<string, unknown>[];
    }
  }
  return [];
}

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function openInBrowser(target: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* printing the URL is enough */
  }
}

export function registerProject(program: Command): void {
  program
    .command("projects")
    .description("List your projects")
    .option("--json", "print JSON")
    .action(
      action(async (opts: { json?: boolean }) => {
        const res = await (await getClient()).listProjects();
        if (opts.json) return printJson(res);
        const rows = asArray(res, ["projects", "items", "data"]);
        if (rows.length === 0) {
          process.stdout.write("No projects yet. Run `rivtor deploy` in your project folder.\n");
          return;
        }
        process.stdout.write(
          table(rows.map((p) => [pc.bold(str(p.slug ?? p.name)), p.status ? statusColor(str(p.status)) : "", p.url ? url(str(p.url)) : "", pc.dim(str(p.updated_at ?? p.updatedAt))])) + "\n",
        );
      }),
    );

  program
    .command("status")
    .description("Show services, URLs and data services of a project")
    .argument("[project]", "project slug (default: rivtor.json / folder name)")
    .option("--json", "print JSON")
    .action(
      action(async (project: string | undefined, opts: { json?: boolean }) => {
        const slug = await projectSlug(project);
        const res = await (await getClient()).getProject(slug);
        if (opts.json) return printJson(res);
        const p = (res.project && typeof res.project === "object" ? res.project : res) as Record<string, unknown>;
        process.stdout.write(`${pc.bold(str(p.slug ?? slug))}${p.plan ? pc.dim(`  ${str(p.plan)} plan`) : ""}\n`);
        const services = asArray(res, ["services"]) as unknown as ServiceStatus[];
        const urls = (res.urls && typeof res.urls === "object" ? res.urls : {}) as Record<string, string>;
        if (services.length) process.stdout.write(formatServices(services, urls) + "\n");
        else process.stdout.write(pc.dim("  no services deployed yet\n"));
        const data = asArray(res, ["data", "dataServices", "data_services"]);
        if (data.length) {
          process.stdout.write(
            table(data.map((d) => [pc.bold(str(d.kind)), statusColor(str(d.status)), pc.dim(typeof d.sizeBytes === "number" ? `${formatBytes(d.sizeBytes)}${typeof d.limitBytes === "number" ? ` / ${formatBytes(d.limitBytes)}` : ""}` : "")])) + "\n",
          );
        }
        const last = (res.lastDeployment ?? res.last_deployment) as Record<string, unknown> | undefined;
        if (last) process.stdout.write(pc.dim(`  last deploy ${str(last.id)} ${str(last.status)} ${str(last.created_at ?? last.createdAt)}\n`));
        if (typeof res.dashboardUrl === "string") process.stdout.write(`  ${pc.dim("dashboard")} ${url(res.dashboardUrl)}\n`);
      }),
    );

  program
    .command("logs")
    .description("Show runtime logs (or a deployment's build log with --build)")
    .argument("[project]", "project slug")
    .option("-s, --service <name>", "only this service")
    .option("--since <window>", "time window, e.g. 15m, 2h, or ISO timestamp")
    .option("--level <level>", "debug | info | warn | error")
    .option("-n, --limit <n>", "max lines", (v) => Number.parseInt(v, 10))
    .option("--raw", "raw lines instead of the summary")
    .option("--build <deploymentId>", "show the build/deploy log of a deployment")
    .option("--json", "print JSON")
    .action(
      action(async (project: string | undefined, opts: { service?: string; since?: string; level?: string; limit?: number; raw?: boolean; build?: string; json?: boolean }) => {
        const client = await getClient();
        const res = opts.build
          ? await client.getDeploymentLogs(opts.build)
          : await client.projectLogs(await projectSlug(project), { service: opts.service, since: opts.since, level: opts.level, limit: opts.limit, summary: opts.raw ? false : undefined });
        if (opts.json) return printJson(res);
        const summary = res && typeof res === "object" && !Array.isArray(res) ? (res as Record<string, unknown>).summary : undefined;
        if (typeof summary === "string" && summary) process.stdout.write(summary.trimEnd() + "\n");
        else if (Array.isArray(summary)) for (const s of summary) process.stdout.write(`${typeof s === "string" ? s : JSON.stringify(s)}\n`);
        const { lines } = normalizeLogs(res);
        for (const l of lines) {
          const lvl = l.level === "error" || l.level === "stderr" ? pc.red(l.level) : l.level === "warn" ? pc.yellow(l.level) : pc.dim(l.level ?? "");
          const prefix = [l.ts ? pc.dim(l.ts) : "", l.service ?? l.stage ? pc.cyan(l.service ?? l.stage ?? "") : "", l.level ? lvl : ""].filter(Boolean).join(" ");
          process.stdout.write(`${prefix ? prefix + " " : ""}${l.message}\n`);
        }
        if (!summary && lines.length === 0) process.stdout.write(pc.dim("No log lines.\n"));
      }),
    );

  program
    .command("rollback")
    .description("Roll back to a previous release (default: the one before current)")
    .argument("[releaseId]", "release to roll back to")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (releaseId: string | undefined, opts: { project?: string; json?: boolean }) => {
        const slug = await projectSlug(opts.project);
        const res = await (await getClient()).rollback(slug, releaseId);
        if (opts.json) return printJson(res);
        process.stdout.write(`${pc.green("✓")} Rolled back ${pc.bold(slug)}${releaseId ? ` to ${releaseId}` : ""}\n`);
        const o = (res ?? {}) as Record<string, unknown>;
        if (o.urls && typeof o.urls === "object") for (const [n, u] of Object.entries(o.urls as Record<string, string>)) process.stdout.write(`  ${pc.bold(n)}  ${url(u)}\n`);
      }),
    );

  const domain = program.command("domain").description("Manage custom domains");
  domain
    .command("add")
    .description("Attach a custom domain and print the DNS record to create")
    .argument("<hostname>", "e.g. www.example.com")
    .option("-s, --service <name>", "service to route to (default: primary public service)")
    .option("-p, --project <slug>", "project slug")
    .option("--json", "print JSON")
    .action(
      action(async (hostname: string, opts: { service?: string; project?: string; json?: boolean }) => {
        const slug = await projectSlug(opts.project);
        const res = await (await getClient()).domainAdd(slug, hostname.trim().toLowerCase(), opts.service);
        if (opts.json) return printJson(res);
        process.stdout.write(`${pc.green("✓")} ${pc.bold(hostname)} added to ${pc.bold(slug)}. Create this DNS record:\n`);
        const o = (res ?? {}) as Record<string, unknown>;
        const records = asArray(o, ["records", "dns"]);
        const single = [o.record, o.dns].find((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<string, unknown> | undefined;
        const all = records.length ? records : single ? [single] : "type" in o ? [o] : [];
        if (all.length) process.stdout.write(table(all.map((r) => [pc.bold(str(r.type)), str(r.name), pc.cyan(str(r.value ?? r.target ?? r.content))])) + "\n");
        else process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        process.stdout.write(pc.dim("  TLS is issued automatically once DNS resolves.\n"));
      }),
    );

  program
    .command("destroy")
    .description("Delete a project, its services and ALL its data")
    .argument("[project]", "project slug")
    .option("--confirm <slug>", "non-interactive confirmation: must equal the project slug")
    .option("--json", "print JSON")
    .action(
      action(async (project: string | undefined, opts: { confirm?: string; json?: boolean }) => {
        const slug = await projectSlug(project);
        const client = await getClient();
        const first = await client.destroy(slug);
        const token = str(first.confirm_token ?? first.confirmToken);
        if (!token) throw new CliError("The API did not return a confirmation token; nothing was deleted.");
        let typed = opts.confirm;
        if (typed === undefined) {
          if (!process.stdin.isTTY) throw new CliError(`Refusing to destroy without confirmation. Re-run with --confirm ${slug}.`);
          process.stderr.write(`${pc.red(pc.bold("This permanently deletes"))} ${pc.bold(slug)}, all its services, databases and files.\n`);
          typed = await ask(`Type ${pc.bold(slug)} to confirm: `);
        }
        if (typed !== slug) {
          process.stderr.write("Confirmation did not match; nothing was deleted.\n");
          return EXIT.FAILED;
        }
        const res = await client.destroy(slug, token);
        if (opts.json) return printJson(res ?? { project: slug, destroyed: true });
        process.stdout.write(`${pc.green("✓")} Destroyed ${pc.bold(slug)}\n`);
      }),
    );

  program
    .command("upgrade")
    .description("Open a checkout link to upgrade your plan")
    .argument("[plan]", "hobby | pro | team", "hobby")
    .option("--interval <interval>", "month | year", "month")
    .option("--provider <provider>", "stripe | razorpay")
    .option("--currency <currency>", "usd | inr")
    .option("--no-open", "print the link without opening a browser")
    .option("--json", "print JSON")
    .action(
      action(async (plan: string, opts: { interval: string; provider?: string; currency?: string; open: boolean; json?: boolean }) => {
        if (!["hobby", "pro", "team"].includes(plan)) throw new CliError(`Unknown plan "${plan}". Choose hobby, pro or team.`);
        if (!["month", "year"].includes(opts.interval)) throw new CliError(`--interval must be "month" or "year".`);
        const res = await (await getClient()).checkout({ plan, interval: opts.interval, provider: opts.provider, currency: opts.currency });
        if (opts.json) return printJson(res);
        const link = str(res.url);
        if (!link) throw new CliError("The API did not return a checkout URL.");
        process.stdout.write(`Upgrade to ${pc.bold(plan)}: ${url(link)}\n`);
        if (opts.open && process.stdout.isTTY) openInBrowser(link);
      }),
    );
}
