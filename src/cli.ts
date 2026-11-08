import { Command } from "commander";
import { registerAuth } from "./commands/auth.js";
import { registerDb } from "./commands/db.js";
import { registerDeploy } from "./commands/deploy.js";
import { registerEnv } from "./commands/env.js";
import { registerVerify } from "./commands/verify.js";
import { registerWatch } from "./commands/watch.js";
import { registerImport } from "./commands/import.js";
import { registerProject } from "./commands/project.js";
import { registerSkills } from "./commands/skills.js";
import { getClient } from "./context.js";

export function buildProgram(version: string): Command {
  const program = new Command();
  program
    .name("rivtor")
    .description("Deploy any app (frontend + backend + database) with one command.")
    .version(version, "-v, --version")
    .showHelpAfterError()
    .addHelpText(
      "after",
      "\nGet started:\n  rivtor login\n  rivtor deploy\n\nUse from AI agents:\n  claude mcp add rivtor -- npx -y rivtor mcp\n  rivtor skills install --target claude\n\nEnv: RIVTOR_TOKEN, RIVTOR_API_URL override the saved config (~/.config/rivtor/config.json).",
    );

  registerAuth(program);
  registerDeploy(program);
  registerProject(program);
  registerEnv(program);
  registerDb(program);
  registerVerify(program);
  registerWatch(program);
  registerImport(program);
  registerSkills(program);

  program
    .command("mcp")
    .description("Run the Rivtor MCP server over stdio (for Claude Code, Cursor, Codex, ...)")
    .action(async () => {
      const { createMcpServer } = await import("./mcp.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const server = createMcpServer({ getClient, version });
      await server.connect(new StdioServerTransport());
      process.stderr.write(`rivtor MCP server ${version} running on stdio\n`);
    });

  return program;
}
