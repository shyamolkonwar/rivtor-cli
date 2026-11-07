import type { Command } from "commander";
import pc from "picocolors";
import { ApiClient } from "../api.js";
import { clearToken, configPath, normalizeApiUrl, readConfig, resolveConfig, writeConfig } from "../config.js";
import { DEFAULT_API_URL, EXIT, NOT_LOGGED_IN_MESSAGE, TOKENS_URL } from "../constants.js";
import { CliError, action, cliVersion, printJson } from "../context.js";
import { askSecret } from "../prompt.js";

export function looksLikeToken(token: string): boolean {
  if (/\s/.test(token)) return false;
  if (token.startsWith("rvt_")) return token.length >= 12;
  return token.split(".").length === 3 && token.length > 40; // dashboard JWT
}

export function describeMe(me: Record<string, unknown>): { email: string | null; plan: string | null } {
  const pick = (o: unknown, keys: string[]): string | null => {
    if (!o || typeof o !== "object") return null;
    for (const k of keys) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === "string" && v) return v;
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string") return (v as Record<string, string>).id;
    }
    return null;
  };
  const email = pick(me, ["email"]) ?? pick(me.profile, ["email"]) ?? pick(me.user, ["email"]);
  const plan = pick(me, ["effectivePlan", "effective_plan", "plan"]) ?? pick(me.profile, ["effective_plan", "plan"]);
  return { email, plan };
}

export function registerAuth(program: Command): void {
  program
    .command("login")
    .description("Save an API token (create one at rivtor.com/dashboard/tokens)")
    .option("--token <token>", "API token (rvt_...); omit to paste it interactively")
    .option("--api-url <url>", "API base URL (default https://api.rivtor.com)")
    .action(
      action(async (opts: { token?: string; apiUrl?: string }) => {
        let token = opts.token?.trim();
        if (!token) {
          process.stderr.write(`Create a token at ${pc.cyan(pc.underline(TOKENS_URL))} and paste it below.\n`);
          token = await askSecret("Token: ");
        }
        if (!token) throw new CliError("No token given.");
        if (!looksLikeToken(token)) throw new CliError(`That doesn't look like a Rivtor API token (they start with "rvt_"). Create one at ${TOKENS_URL}.`);

        const resolved = await resolveConfig();
        const apiUrl = opts.apiUrl ? normalizeApiUrl(opts.apiUrl) : resolved.apiUrl;
        const client = new ApiClient({ apiUrl, token, userAgent: `rivtor-cli/${await cliVersion()}` });
        const me = await client.me();
        const cfg = await readConfig();
        cfg.token = token;
        if (opts.apiUrl && apiUrl !== DEFAULT_API_URL) cfg.apiUrl = apiUrl;
        const path = await writeConfig(cfg);
        const { email, plan } = describeMe(me);
        process.stdout.write(`${pc.green("✓")} Logged in${email ? ` as ${pc.bold(email)}` : ""}${plan ? pc.dim(` (${plan} plan)`) : ""}\n`);
        process.stdout.write(pc.dim(`  token saved to ${path}\n`));
      }),
    );

  program
    .command("logout")
    .description("Remove the saved API token")
    .action(
      action(async () => {
        const removed = await clearToken();
        process.stdout.write(removed ? `${pc.green("✓")} Logged out\n` : "Not logged in.\n");
        if (process.env.RIVTOR_TOKEN) process.stderr.write(pc.yellow("  RIVTOR_TOKEN is still set in your environment.\n"));
      }),
    );

  program
    .command("whoami")
    .description("Show the logged-in account")
    .option("--json", "print JSON")
    .action(
      action(async (opts: { json?: boolean }) => {
        const cfg = await resolveConfig();
        if (!cfg.token) {
          if (opts.json) printJson({ loggedIn: false, apiUrl: cfg.apiUrl });
          else process.stderr.write(NOT_LOGGED_IN_MESSAGE + "\n");
          return EXIT.FAILED;
        }
        const client = new ApiClient({ apiUrl: cfg.apiUrl, token: cfg.token, userAgent: `rivtor-cli/${await cliVersion()}` });
        const me = await client.me();
        if (opts.json) return printJson(me);
        const { email, plan } = describeMe(me);
        process.stdout.write(`${pc.bold(email ?? "(unknown email)")}${plan ? `  ${pc.dim(`${plan} plan`)}` : ""}\n`);
        process.stdout.write(pc.dim(`  api ${cfg.apiUrl} · token from ${cfg.tokenSource === "env" ? "RIVTOR_TOKEN" : configPath()}\n`));
      }),
    );
}
