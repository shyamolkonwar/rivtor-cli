// `rivtor env pull`: write the project's env vars to a local file (.env.local / .env).
// Values go only into the file (mode 0600); the CLI prints counts, never values.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface EnvExport {
  project: string;
  set: "local" | "production";
  service: string | null;
  vars: Record<string, string>;
  omitted: Array<{ key: string; reason: string }>;
  comments: string[];
  database?: { host: string; port: number; expiresAt: string };
}

/** `.env.local` for Next.js / Vite apps (they load it and keep it out of git by convention), else `.env`. */
export async function defaultEnvFile(dir: string): Promise<string> {
  const configs = [
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.ts",
  ];
  if (configs.some((f) => existsSync(join(dir, f)))) return ".env.local";
  try {
    const pkg = JSON.parse(
      await readFile(join(dir, "package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next || deps.vite) return ".env.local";
  } catch {
    // no package.json: not a JS app
  }
  return ".env";
}

/** Dotenv value that parseEnvFile (and dotenv/Next/Vite) read back exactly. */
export function quoteEnvValue(v: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

export function renderEnvFile(res: EnvExport, now = new Date()): string {
  const lines = [
    `# Written by \`rivtor env pull\` for ${res.project} (${res.set} set${res.service ? `, service ${res.service}` : ""}) at ${now.toISOString()}.`,
    "# Contains secrets: do not commit this file.",
    ...res.comments.map((c) => `# ${c}`),
    "",
    ...Object.entries(res.vars).map(([k, v]) => `${k}=${quoteEnvValue(v)}`),
  ];
  return lines.join("\n") + "\n";
}

/**
 * Makes sure `.env*` is ignored by git in `dir`. Appends `.env*` when no line already covers it,
 * re-adding existing `!.env...` exceptions (e.g. `!.env.example`) after it so they keep working.
 * Returns true when .gitignore was changed.
 */
export async function ensureGitignore(dir: string): Promise<boolean> {
  const path = join(dir, ".gitignore");
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l === ".env*" || l === "/.env*")) return false;
  const exceptions = lines.filter((l) => /^!\/?\.env/.test(l));
  const add = [
    "# local env files (rivtor env pull)",
    ".env*",
    ...exceptions,
  ].join("\n");
  await writeFile(
    path,
    `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${add}\n`,
  );
  return true;
}

export class EnvFileExistsError extends Error {}

/** Writes the file; refuses to overwrite an existing one unless `force` (no merging: the file is replaced). */
export async function writeEnvPull(
  path: string,
  res: EnvExport,
  force: boolean,
): Promise<void> {
  if (existsSync(path) && !force)
    throw new EnvFileExistsError(
      `${path} already exists. Re-run with --force to replace it (its current contents are not merged).`,
    );
  await writeFile(path, renderEnvFile(res), { mode: 0o600 });
}
