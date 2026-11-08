import type { AgentError, DeployPlan, DeployResult, MissingSecret, ServiceStatus } from "./shared.js";
import pc from "picocolors";
import { formatVerification } from "./verification.js";
import { EXIT } from "./constants.js";

export function exitCodeFor(status: string | undefined): number {
  if (status === "live") return EXIT.OK;
  if (status === "needs_input") return EXIT.NEEDS_INPUT;
  return EXIT.FAILED;
}

export const url = (u: string) => pc.cyan(pc.underline(u));

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function pad(s: string, n: number): string {
  // pad by visible length (strip ANSI)
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, n - visible));
}

export function table(rows: string[][], indent = "  "): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  // eslint-disable-next-line no-control-regex
  const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, vis(c))));
  return rows
    .map((r) => indent + r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i] + 2))).join("").trimEnd())
    .join("\n");
}

export function statusColor(status: string): string {
  switch (status) {
    case "live":
    case "ready":
    case "active":
      return pc.green(status);
    case "failed":
    case "error":
    case "read_only":
      return pc.red(status);
    case "sleeping":
    case "stopped":
      return pc.dim(status);
    case "needs_input":
      return pc.yellow(status);
    default:
      return pc.yellow(status);
  }
}

export function formatMissingSecrets(missing: MissingSecret[], project?: string): string {
  const lines = missing.map((m) => {
    const where = m.usedIn?.length ? pc.dim(` used in ${m.usedIn.slice(0, 3).join(", ")}${m.usedIn.length > 3 ? ", …" : ""}`) : "";
    return `  ${pc.bold(m.name)} ${pc.dim(`(${m.service})`)}${where}`;
  });
  const services = [...new Set(missing.map((m) => m.service))];
  const hint = services
    .map((svc) => {
      const keys = missing.filter((m) => m.service === svc).map((m) => `${m.name}=...`).join(" ");
      return `  rivtor env set ${keys}${services.length > 1 ? ` --service ${svc}` : ""}${project ? ` --project ${project}` : ""}`;
    })
    .join("\n");
  return `${lines.join("\n")}\n\n${pc.dim("Set them, then deploy again:")}\n${hint}`;
}

export function formatAgentError(err: AgentError): string {
  const head = err.status === "needs_input" ? pc.yellow("! Needs input") : pc.red("✗ Failed");
  const where = [err.stage, err.service].filter(Boolean).join(" · ");
  const out = [`${head}${where ? pc.dim(` (${where})`) : ""} ${pc.dim(`[${err.code}]`)}`];
  out.push(`  ${pc.bold("cause")}  ${err.cause}`);
  if (err.file) out.push(`  ${pc.bold("file")}   ${err.file}`);
  out.push(`  ${pc.bold("fix")}    ${err.fix}`);
  if (err.missing?.length) out.push("", formatMissingSecrets(err.missing));
  if (err.upgrade) out.push("", `  ${pc.magenta("↑")} ${err.upgrade.message} ${url(err.upgrade.url)}`);
  if (err.logTail?.length) {
    out.push("", pc.dim("  last log lines:"));
    for (const l of err.logTail.slice(-15)) out.push(pc.dim(`  │ ${l}`));
  }
  if (err.docs) out.push(`  ${pc.dim("docs")}   ${url(err.docs)}`);
  return out.join("\n");
}

export function formatServices(services: ServiceStatus[], urls: Record<string, string> = {}): string {
  return table(
    services.map((s) => [
      pc.bold(s.name),
      statusColor(s.status),
      pc.dim(s.framework ?? s.kind),
      s.url ?? urls[s.name] ? url((s.url ?? urls[s.name]) as string) : pc.dim(s.kind === "worker" ? "(worker, no URL)" : "—"),
    ]),
  );
}

export function formatDeployResult(r: DeployResult): string {
  const out: string[] = [];
  const dur = r.durationMs ? pc.dim(` in ${formatDuration(r.durationMs)}`) : "";
  if (r.status === "live") out.push(`${pc.green("✓ Live")}  ${pc.bold(r.project)}${dur}`);
  else if (r.status === "needs_input") out.push(`${pc.yellow("! Needs input")}  ${pc.bold(r.project)}`);
  else out.push(`${pc.red("✗ Deploy failed")}  ${pc.bold(r.project)}${dur}`);

  const services = r.services ?? [];
  if (services.length) out.push(formatServices(services, r.urls));
  else {
    const rows = Object.entries(r.urls ?? {}).map(([name, u]) => [pc.bold(name), url(u)]);
    if (rows.length) out.push(table(rows));
  }
  if (r.data?.length) {
    out.push(
      table(r.data.map((d) => [pc.bold(d.kind), statusColor(d.status), pc.dim(d.limitBytes ? `${formatBytes(d.sizeBytes)} / ${formatBytes(d.limitBytes)}` : "")])),
    );
  }
  if (r.databaseUrl) out.push(`  ${pc.dim("DATABASE_URL")} ${r.databaseUrl}`);
  if (r.error) out.push("", formatAgentError(r.error));
  else if (r.status === "needs_input" && r.plan?.missingSecrets?.length) {
    out.push("", pc.yellow("Missing secrets:"), formatMissingSecrets(r.plan.missingSecrets, r.project));
  }
  for (const n of r.notes ?? []) out.push(pc.dim(`  • ${n}`));
  if (r.upgrade) out.push(`  ${pc.magenta("↑")} ${r.upgrade.message} ${url(r.upgrade.url)}`);
  if (r.dashboardUrl) out.push(`  ${pc.dim("dashboard")} ${url(r.dashboardUrl)}`);
  if (r.verification) out.push("", formatVerification(r.verification));
  else out.push("", pc.dim(r.verificationSkipped ? "Verification skipped. No working verdict was issued." : "No verification report returned. Deployment status is not a working verdict."));
  return out.join("\n");
}

export function formatPlan(plan: DeployPlan, project?: string): string {
  const out: string[] = [`${pc.bold("Deploy plan")}${project ? ` for ${pc.bold(project)}` : ""} ${pc.dim("(dry run, nothing was deployed)")}`];
  out.push(
    "",
    table(
      plan.services.map((s) => [
        pc.bold(s.name),
        pc.dim(s.rootDir),
        `${s.kind}${s.framework ? `/${s.framework}` : ""}`,
        `${s.runtime}·${s.builder}`,
        s.port ? `:${s.port}` : "",
        s.public ? "" : pc.dim("private"),
      ]),
    ),
  );
  if (plan.data.length) out.push("", `${pc.bold("Data")}  ${plan.data.join(", ")}`);
  const wiring = plan.services.flatMap((s) => Object.entries(s.wiring ?? {}).map(([k, target]) => `${s.name}.${k} → ${target}`));
  if (wiring.length) out.push("", pc.bold("Wiring"), ...wiring.map((w) => `  ${w}`));
  if (plan.env.length) {
    out.push("", pc.bold("Env"), table(plan.env.map((e) => [e.service, e.key, pc.dim(e.source), pc.dim(e.valuePreview)])));
  }
  if (plan.missingSecrets.length) out.push("", pc.yellow("Missing secrets"), formatMissingSecrets(plan.missingSecrets, project));
  if (plan.assumptions.length) {
    out.push("", pc.bold("Assumptions"));
    for (const a of plan.assumptions) {
      out.push(`  • ${a.service ? pc.dim(`[${a.service}] `) : ""}${a.message}${a.override ? pc.dim(` (override: ${a.override})`) : ""}`);
    }
  }
  for (const w of plan.warnings) out.push(pc.yellow(`  ⚠ ${w}`));
  return out.join("\n");
}
