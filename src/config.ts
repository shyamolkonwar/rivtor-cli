import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_API_URL } from "./constants.js";

export interface RivtorConfig {
  token?: string;
  apiUrl?: string;
}

export interface ResolvedConfig {
  token: string | null;
  apiUrl: string;
  /** where the token came from, for `whoami` */
  tokenSource: "env" | "config" | null;
}

type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  if (env.RIVTOR_CONFIG_DIR) return env.RIVTOR_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), ".config"), "rivtor");
}

export function configPath(env: Env = process.env): string {
  return join(configDir(env), "config.json");
}

export async function readConfig(env: Env = process.env): Promise<RivtorConfig> {
  let text: string;
  try {
    text = await readFile(configPath(env), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: RivtorConfig = {};
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.token === "string" && obj.token) out.token = obj.token;
    if (typeof obj.apiUrl === "string" && obj.apiUrl) out.apiUrl = obj.apiUrl;
    return out;
  } catch {
    // A corrupt config is treated as empty; `rivtor login` rewrites it.
    return {};
  }
}

/** Writes the config file with mode 0600 inside a 0700 directory. */
export async function writeConfig(cfg: RivtorConfig, env: Env = process.env): Promise<string> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  await writeFile(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  // writeFile only applies mode on create; enforce it for pre-existing files too.
  await chmod(path, 0o600);
  return path;
}

export async function clearToken(env: Env = process.env): Promise<boolean> {
  const cfg = await readConfig(env);
  if (!cfg.token) return false;
  delete cfg.token;
  if (Object.keys(cfg).length === 0) {
    await rm(configPath(env), { force: true });
  } else {
    await writeConfig(cfg, env);
  }
  return true;
}

export function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export async function resolveConfig(env: Env = process.env): Promise<ResolvedConfig> {
  const cfg = await readConfig(env);
  const envToken = env.RIVTOR_TOKEN?.trim();
  const token = envToken || cfg.token || null;
  const tokenSource = envToken ? "env" : cfg.token ? "config" : null;
  const apiUrl = normalizeApiUrl(env.RIVTOR_API_URL?.trim() || cfg.apiUrl || DEFAULT_API_URL);
  return { token, apiUrl, tokenSource };
}
