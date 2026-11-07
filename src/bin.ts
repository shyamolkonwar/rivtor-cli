#!/usr/bin/env node
import { buildProgram } from "./cli.js";
import { cliVersion } from "./context.js";

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (major < 20) {
  process.stderr.write(`rivtor needs Node.js 20 or newer (you have ${process.versions.node}).\n`);
  process.exit(1);
}

const program = buildProgram(await cliVersion());
await program.parseAsync(process.argv);
