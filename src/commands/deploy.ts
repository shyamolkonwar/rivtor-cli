import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pc from "picocolors";
import type { LogLine } from "../api.js";
import { EXIT } from "../constants.js";
import { CliError, action, getClient, printJson } from "../context.js";
import { type ProgressEvent, runDeploy } from "../deploy.js";
import { parseEnvFile } from "../envfile.js";
import { exitCodeFor, formatBytes, formatDeployResult, formatDuration, formatPlan } from "../output.js";

/** Live progress on stderr: one updating line on a TTY, one line per stage otherwise. */
export class ProgressPrinter {
  private stage: string | null = null;
  private stageStarted = Date.now();
  private lastLine = "";
  private readonly tty: boolean;
  constructor(private readonly out: NodeJS.WriteStream = process.stderr) {
    this.tty = Boolean(out.isTTY);
  }

  handle = (ev: ProgressEvent): void => {
    switch (ev.type) {
      case "packed":
        this.println(
          ev.changed === undefined
            ? `${pc.dim("•")} packed ${ev.files} files ${pc.dim(`(${formatBytes(ev.bytes)})`)}`
            : `${pc.dim("•")} ${ev.files} files, ${ev.changed} changed ${pc.dim(`(${formatBytes(ev.bytes)} to upload)`)}`,
        );
        break;
      case "uploading":
        this.println(`${pc.dim("•")} uploading to ${pc.bold(ev.project)}`);
        break;
      case "started":
        this.println(`${pc.dim("•")} deployment ${pc.dim(ev.deploymentId)}`);
        break;
      case "stage":
        this.finishStage();
        this.stage = ev.stage;
        this.stageStarted = Date.now();
        this.lastLine = "";
        this.render();
        break;
      case "log":
        this.onLog(ev.line);
        break;
    }
  };

  private onLog(line: LogLine): void {
    const msg = line.message.replace(/\s+/g, " ").trim();
    if (!msg) return;
    this.lastLine = (line.service ? `${line.service}: ` : "") + msg;
    this.render();
  }

  private render(): void {
    if (!this.stage) return;
    if (!this.tty) return; // non-TTY: stage lines are printed when they finish
    const cols = this.out.columns ?? 100;
    const head = `${pc.cyan("●")} ${this.stage}`;
    const room = Math.max(0, cols - this.stage.length - 6);
    const tail = this.lastLine ? ` ${pc.dim(this.lastLine.slice(0, room))}` : "";
    this.out.write(`\r\x1b[2K${head}${tail}`);
  }

  private finishStage(): void {
    if (!this.stage) return;
    const line = `${pc.green("✓")} ${this.stage} ${pc.dim(formatDuration(Date.now() - this.stageStarted))}`;
    if (this.tty) this.out.write(`\r\x1b[2K${line}\n`);
    else this.out.write(`${line}\n`);
    this.stage = null;
  }

  private println(s: string): void {
    if (this.tty && this.stage) this.out.write("\r\x1b[2K");
    this.out.write(s + "\n");
    this.render();
  }

  done(status?: string): void {
    if (!this.stage) return;
    if (status === "live") this.finishStage();
    else {
      const mark = status === "needs_input" ? pc.yellow("!") : pc.red("✗");
      this.out.write(`${this.tty ? "\r\x1b[2K" : ""}${mark} ${this.stage}\n`);
      this.stage = null;
    }
  }
}

export function registerDeploy(program: Command): void {
  program
    .command("deploy")
    .description("Deploy a folder (frontend + backend + data) and print live URLs")
    .argument("[path]", "project folder", ".")
    .option("-p, --project <slug>", "project slug (default: rivtor.json, else folder name)")
    .option("--dry-run", "only detect and print the deploy plan")
    .option("--json", "print the raw DeployResult JSON")
    .option("--no-verify", "skip post-deploy verification (does not bypass release security checks)")
    .option("--no-wait", "start the deployment and exit without waiting")
    .option("--env-file <file>", "send variables from a dotenv file with this deploy")
    .option("--clean", "rebuild every service from scratch, without build or dependency caches")
    .option("--approval-token <token>", "token from an approved destructive migration (after a deploy returned needs approval)")
    .action(
      action(async (path: string, opts: { project?: string; dryRun?: boolean; json?: boolean; wait: boolean; envFile?: string; clean?: boolean; verify: boolean; approvalToken?: string }) => {
        const client = await getClient();
        let env: Record<string, string> | undefined;
        if (opts.envFile) {
          try {
            env = parseEnvFile(await readFile(resolve(opts.envFile), "utf8"));
          } catch (err) {
            throw new CliError(`Could not read --env-file ${opts.envFile}: ${(err as Error).message}`);
          }
        }
        const progress = opts.json ? null : new ProgressPrinter();
        const outcome = await runDeploy(client, {
          dir: path,
          project: opts.project,
          dryRun: opts.dryRun,
          wait: opts.wait,
          env,
          clean: opts.clean,
          verify: opts.verify,
          approvalToken: opts.approvalToken,
          onProgress: progress?.handle,
        });

        if (outcome.kind === "started") {
          if (opts.json) printJson({ deploymentId: outcome.deploymentId, project: outcome.project.slug });
          else {
            process.stdout.write(`${pc.green("✓")} Deployment ${pc.bold(outcome.deploymentId)} started for ${pc.bold(outcome.project.slug)}\n`);
            process.stdout.write(pc.dim(`  follow with: rivtor status ${outcome.project.slug}  ·  rivtor logs --build ${outcome.deploymentId}\n`));
          }
          return EXIT.OK;
        }
        if (outcome.kind === "plan") {
          if (opts.json) printJson(outcome.raw);
          else process.stdout.write(formatPlan(outcome.plan, outcome.project.slug) + "\n");
          return EXIT.OK;
        }
        const result = outcome.result;
        progress?.done(result.status);
        if (opts.json) printJson(result);
        else if (opts.dryRun && result.plan) process.stdout.write(formatPlan(result.plan, outcome.project.slug) + "\n");
        else process.stdout.write(formatDeployResult(result) + "\n");
        if (opts.dryRun && result.status === "live") return EXIT.OK;
        return exitCodeFor(result.status);
      }),
    );
}
