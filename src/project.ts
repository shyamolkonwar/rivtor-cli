import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const SLUG_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const RIVTOR_JSON = "rivtor.json";

/** Turns any folder name into a valid project slug (`^[a-z][a-z0-9-]{0,30}$`). */
export function sanitizeSlug(name: string): string {
  let s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) return "my-app";
  if (!/^[a-z]/.test(s)) s = `app-${s}`;
  s = s.slice(0, 31).replace(/-+$/g, "");
  return SLUG_RE.test(s) ? s : "my-app";
}

export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

export interface RivtorJson {
  project: string;
  [key: string]: unknown;
}

/** Reads `<dir>/rivtor.json`. Returns null when absent; throws ProjectConfigError when invalid. */
export async function readRivtorJson(dir: string): Promise<RivtorJson | null> {
  const path = join(dir, RIVTOR_JSON);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectConfigError(`${path} is not valid JSON. Fix it (expected {"project": "<slug>"}) or delete it.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProjectConfigError(`${path} must be a JSON object like {"project": "<slug>"}.`);
  }
  const project = (parsed as Record<string, unknown>).project;
  if (project === undefined) return null;
  if (typeof project !== "string" || !SLUG_RE.test(project)) {
    throw new ProjectConfigError(
      `${path}: "project" must be a slug matching ${SLUG_RE.source} (lowercase letters, digits, dashes).`,
    );
  }
  return parsed as RivtorJson;
}

/** Writes rivtor.json, preserving any other keys already present. */
export async function writeRivtorJson(dir: string, project: string): Promise<string> {
  const path = join(dir, RIVTOR_JSON);
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
  } catch {
    /* absent or invalid: overwrite */
  }
  await writeFile(path, JSON.stringify({ ...existing, project }, null, 2) + "\n");
  return path;
}

export interface ResolvedProject {
  slug: string;
  source: "flag" | "rivtor.json" | "folder";
}

/** --project flag > rivtor.json > sanitised folder name. */
export async function resolveProject(dir: string, flag?: string | null): Promise<ResolvedProject> {
  if (flag) {
    const slug = flag.trim();
    if (!SLUG_RE.test(slug)) {
      throw new ProjectConfigError(
        `Invalid project slug "${flag}". Use lowercase letters, digits and dashes, starting with a letter (max 31 chars), e.g. "${sanitizeSlug(flag)}".`,
      );
    }
    return { slug, source: "flag" };
  }
  const json = await readRivtorJson(dir);
  if (json) return { slug: json.project, source: "rivtor.json" };
  return { slug: sanitizeSlug(basename(resolve(dir))), source: "folder" };
}
