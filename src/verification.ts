import type { VerificationReport, VerifySummary } from "./shared.js";
import pc from "picocolors";

const labels = { working: "Working", partly_working: "Partly working", broken: "Broken" };
// Strip terminal control sequences from server-supplied diagnostics.
const text = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
export function formatVerification(report: VerificationReport): string {
  const label = labels[report.verdict] ?? "Unknown verdict";
  const color = report.verdict === "working" ? pc.green : report.verdict === "broken" ? pc.red : pc.yellow;
  const lines = [color(`Verification: ${label}`), `  ${text(report.summary)}`,
    `  ${report.checks.passed} passed · ${report.checks.warnings} warnings · ${report.checks.failed} failed`,
    `  ${report.mode} check · ${report.trigger}`];
  if (report.blocked) lines.push("  Release blocked; this report does not mean the candidate is live.");
  for (const issue of report.issues) {
    lines.push(`  [${issue.severity}] ${text(issue.where)} (${issue.check})`, `    cause: ${text(issue.cause)}`);
    if (issue.file) lines.push(`    file: ${text(issue.file)}`);
    lines.push(`    fix: ${text(issue.fix)}`);
  }
  for (const group of report.groups) if (!group.ran) lines.push(`  Not checked: ${group.group} — ${text(group.reason ?? "No reason provided")}`);
  lines.push(`  report: ${text(report.report_url)}`);
  return lines.join("\n");
}

export function formatVerificationSummary(summary?: VerifySummary): string {
  if (!summary) return "Verification: no report available";
  return `Verification: ${summary.verdict ? labels[summary.verdict] ?? "Unknown verdict" : "not yet checked"} · ${summary.openIssues} open issues${summary.at ? ` · ${text(summary.at)}` : ""}${summary.report_url ? `\n  report: ${text(summary.report_url)}` : ""}`;
}
