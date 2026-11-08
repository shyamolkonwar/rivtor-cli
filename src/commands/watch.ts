import type { Command } from "commander";
import { action, CliError, getClient, printJson, projectSlug } from "../context.js";

const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new CliError("Provide the exact issue UUID returned by rivtor issues.");
  return value;
};
export function registerWatch(program: Command): void {
  program.command("issues").description("List privacy-safe production issues (JSON)")
    .argument("[project]", "project slug")
    .option("--status <status>", "open, resolved, dismissed, or all", "open")
    .option("--severity <severity>", "critical, warning, or info")
    .option("--json", "print JSON")
    .action(action(async (project: string | undefined, opts: { status: string; severity?: string }) => {
      if (!["open", "resolved", "dismissed", "all"].includes(opts.status) || (opts.severity && !["critical", "warning", "info"].includes(opts.severity))) throw new CliError("Invalid issue status or severity.");
      const slug = await projectSlug(project), query = new URLSearchParams({ status: opts.status });
      if (opts.severity) query.set("severity", opts.severity);
      printJson(await (await getClient()).request("GET", `/v1/projects/${encodeURIComponent(slug)}/issues?${query}`));
    }));
  program.command("issue-resolve").description("Resolve or dismiss one production issue; does not modify application code")
    .argument("<id>", "issue UUID").option("-p, --project <slug>", "project slug")
    .option("--dismiss", "dismiss a false positive instead of marking resolved").option("--json", "print JSON")
    .action(action(async (id: string, opts: { project?: string; dismiss?: boolean }) => {
      uuid(id); const slug = await projectSlug(opts.project);
      printJson(await (await getClient()).request("POST", `/v1/projects/${encodeURIComponent(slug)}/issues/${encodeURIComponent(id)}/resolve`, { json: { status: opts.dismiss ? "dismissed" : "resolved" } }));
    }));
  program.command("verify-fix").description("Apply only the server's allowlisted fixes for explicit issue IDs, then re-verify")
    .argument("<ids...>", "issue UUIDs").option("-p, --project <slug>", "project slug")
    .option("--yes", "consent to these configuration fixes").option("--json", "print JSON")
    .action(action(async (ids: string[], opts: { project?: string; yes?: boolean }) => {
      if (!opts.yes) throw new CliError("Review the issues first, then pass --yes to consent to configuration changes.");
      if (ids.length > 20) throw new CliError("Fix at most 20 issues per request.");
      const issue_ids = [...new Set(ids.map(uuid))], slug = await projectSlug(opts.project);
      printJson(await (await getClient()).request("POST", `/v1/projects/${encodeURIComponent(slug)}/verify-fix`, { json: { consent: true, issue_ids } }));
    }));
}
