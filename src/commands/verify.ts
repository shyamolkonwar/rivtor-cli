import type { Command } from "commander";
import type { VerificationReport } from "../shared.js";
import { action, getClient, printJson } from "../context.js";
import { projectSlug } from "../context.js";
import { formatVerification } from "../verification.js";
import { EXIT } from "../constants.js";

export function registerVerify(program: Command): void {
  program.command("verify")
    .description("Re-check the current live app without redeploying or applying fixes")
    .argument("[project]", "project slug (default: rivtor.json or folder name)")
    .option("--json", "print the complete verification report")
    .action(action(async (project: string | undefined, opts: { json?: boolean }) => {
      const slug = await projectSlug(project);
      const report = await (await getClient()).request<VerificationReport>("POST", `/v1/projects/${encodeURIComponent(slug)}/verify`, { json: {} });
      if (opts.json) printJson(report);
      else process.stdout.write(formatVerification(report) + "\n");
      return report.verdict === "working" ? EXIT.OK : EXIT.FAILED;
    }));
}
