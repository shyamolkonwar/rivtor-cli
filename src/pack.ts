import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { constants as fsConstants, createReadStream, openAsBlob } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { create as tarCreate } from "tar";
import { MAX_UPLOAD_BYTES } from "./constants.js";

/** Never uploaded (unless a .gitignore explicitly re-includes a build output with `!`). */
export const DEFAULT_IGNORES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  ".next/",
  ".nuxt/",
  ".output/",
  ".svelte-kit/",
  ".astro/",
  ".turbo/",
  ".vercel/",
  ".netlify/",
  ".cache/",
  ".parcel-cache/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  "target/",
  ".gradle/",
  ".idea/",
  ".DS_Store",
  "Thumbs.db",
  "*.log",
];

/** `.env*` files that are safe to upload (documentation of names, not values). */
export const ALLOWED_ENV_FILES = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * Hard exclusions that no ignore file can override: local secrets never leave the machine.
 */
export function isAlwaysExcluded(name: string): boolean {
  return name.startsWith(".env") && !ALLOWED_ENV_FILES.has(name);
}

export class PackError extends Error {
  readonly code: string;
  readonly fix: string;
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.name = "PackError";
    this.code = code;
    this.fix = fix;
  }
}

interface Layer {
  base: string; // posix path of the dir the ignore file lives in ("" for root)
  ig: Ignore;
}

async function loadIgnoreFiles(absDir: string, relDir: string): Promise<Layer | null> {
  const parts: string[] = [];
  for (const file of [".gitignore", ".rivtorignore"]) {
    try {
      parts.push(await readFile(join(absDir, file), "utf8"));
    } catch {
      /* none */
    }
  }
  if (parts.length === 0) return null;
  return { base: relDir, ig: ignore().add(parts.join("\n")) };
}

/**
 * Git-like evaluation across layered ignore files: deeper files override shallower ones and
 * negations (`!build/`) re-include. The `ignore` package also matches parent directories of a
 * path; since the walk only descends into directories that are *not* ignored, a match that
 * comes purely from the parent directory's rule is treated as "no opinion" for that layer.
 */
function isIgnored(layers: Layer[], relPath: string, isDir: boolean): boolean {
  const parent = posix.dirname(relPath);
  let ignored = false;
  for (const { base, ig } of layers) {
    let p = base ? posix.relative(base, relPath) : relPath;
    if (!p || p.startsWith("..")) continue;
    if (isDir) p += "/";
    const r = ig.test(p);
    if (!r.ignored && !r.unignored) continue;
    if (parent !== "." && parent !== base) {
      const pp = base ? posix.relative(base, parent) : parent;
      if (pp && !pp.startsWith("..")) {
        const pr = ig.test(pp + "/");
        if (pr.rule && pr.rule === r.rule) continue; // inherited from the parent dir
      }
    }
    if (r.ignored) ignored = true;
    else if (r.unignored) ignored = false;
  }
  return ignored;
}

export interface ListOptions {
  extraIgnores?: string[];
}

/**
 * Lists files to upload (posix relative paths, sorted). Honors default ignores, nested
 * `.gitignore`/`.rivtorignore` files and `extraIgnores`; `.env*` files (except
 * .env.example/.env.sample/.env.template) are always excluded.
 */
export async function listFiles(rootDir: string, opts: ListOptions = {}): Promise<string[]> {
  const root = resolve(rootDir);
  const s = await stat(root).catch(() => null);
  if (!s || !s.isDirectory()) {
    throw new PackError("path_not_found", `${rootDir} is not a directory.`, "Pass the path of your project folder, then call deploy again.");
  }
  const defaults: Layer = { base: "", ig: ignore().add(DEFAULT_IGNORES) };
  const extra: Layer[] = opts.extraIgnores?.length ? [{ base: "", ig: ignore().add(opts.extraIgnores) }] : [];
  const out: string[] = [];

  async function walk(absDir: string, relDir: string, layers: Layer[]): Promise<void> {
    const own = await loadIgnoreFiles(absDir, relDir);
    // extra ignores (from flags) always apply last so they win over .gitignore negations
    const active = own ? [...layers.slice(0, layers.length - extra.length), own, ...extra] : layers;
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isIgnored(active, rel, true)) continue;
        await walk(join(absDir, e.name), rel, active);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (isAlwaysExcluded(e.name)) continue;
        if (isIgnored(active, rel, false)) continue;
        out.push(rel);
      }
    }
  }

  await walk(root, "", [defaults, ...extra]);
  return out;
}

export interface PackResult {
  /** path of the temporary .tar.gz */
  file: string;
  bytes: number;
  files: string[];
  /** uncompressed size of the packed files */
  rawBytes: number;
  blob(): Promise<Blob>;
  cleanup(): Promise<void>;
}

export interface PackOptions extends ListOptions {
  maxBytes?: number;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Packs a folder into a gzipped tarball in a temp dir. Caller must call `cleanup()`. */
export async function packDir(rootDir: string, opts: PackOptions = {}): Promise<PackResult> {
  const root = resolve(rootDir);
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const files = await listFiles(root, opts);
  if (files.length === 0) {
    throw new PackError("empty_project", `No files to upload in ${rootDir} (everything is ignored or the folder is empty).`, "Check the path and your .gitignore, then call deploy again.");
  }

  const sizes: Array<[string, number]> = [];
  let rawBytes = 0;
  for (const f of files) {
    const st = await stat(join(root, ...f.split("/"))).catch(() => null);
    const size = st?.size ?? 0;
    sizes.push([f, size]);
    rawBytes += size;
  }

  const tmp = await mkdtemp(join(tmpdir(), "rivtor-pack-"));
  const file = join(tmp, "source.tar.gz");
  const cleanup = () => rm(tmp, { recursive: true, force: true });
  try {
    await tarCreate({ gzip: true, cwd: root, file, portable: true, noDirRecurse: true }, files);
    const bytes = (await stat(file)).size;
    if (bytes > maxBytes) {
      const biggest = sizes
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([f, sz]) => `${f} (${formatMb(sz)})`)
        .join(", ");
      throw new PackError(
        "upload_too_large",
        `Project is ${formatMb(bytes)} compressed, over the ${formatMb(maxBytes)} upload limit. Largest files: ${biggest}.`,
        "Add large files, datasets or build outputs to .gitignore (or .rivtorignore), then call deploy again.",
      );
    }
    return {
      file,
      bytes,
      files,
      rawBytes,
      blob: () => openAsBlob(file, { type: "application/gzip" }),
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** For messages: path relative to cwd when inside it. */
export function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return !rel ? "." : rel.startsWith("..") ? p : rel.split(sep).join("/");
}

// ---- incremental upload ------------------------------------------------------------------

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

export interface UploadManifest {
  files: ManifestFile[];
  symlinks?: Array<{ path: string; target: string }>;
}

export interface ManifestResult {
  manifest: UploadManifest;
  /** uncompressed bytes of all files */
  rawBytes: number;
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolvePromise(h.digest("hex")));
  });
}

/**
 * Per-file sha256 manifest of exactly the files `packDir` would upload (same ignore rules, `.env*`
 * never included). Symlinks are listed with their target, like the tarball stores them.
 */
export async function manifestDir(rootDir: string, opts: ListOptions = {}): Promise<ManifestResult> {
  const root = resolve(rootDir);
  const files = await listFiles(root, opts);
  if (files.length === 0) {
    throw new PackError("empty_project", `No files to upload in ${rootDir} (everything is ignored or the folder is empty).`, "Check the path and your .gitignore, then call deploy again.");
  }
  const out: ManifestFile[] = new Array(files.length);
  const symlinks: Array<{ path: string; target: string }> = [];
  let rawBytes = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const rel = files[i]!;
      const abs = join(root, ...rel.split("/"));
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        symlinks.push({ path: rel, target: await readlink(abs) });
        continue;
      }
      rawBytes += st.size;
      out[i] = { path: rel, sha256: await hashFile(abs), size: st.size, mode: st.mode & 0o777 };
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, worker));
  const manifest: UploadManifest = { files: out.filter(Boolean) };
  if (symlinks.length) manifest.symlinks = symlinks.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { manifest, rawBytes };
}

export interface BlobPack {
  file: string;
  bytes: number;
  count: number;
  blob(): Promise<Blob>;
  cleanup(): Promise<void>;
}

/** tar.gz of the files whose hashes the server is missing; each entry is named by its sha256. */
export async function packBlobs(rootDir: string, manifest: UploadManifest, missing: string[], maxBytes = MAX_UPLOAD_BYTES): Promise<BlobPack> {
  const root = resolve(rootDir);
  const want = new Set(missing);
  const tmp = await mkdtemp(join(tmpdir(), "rivtor-blobs-"));
  const cleanup = () => rm(tmp, { recursive: true, force: true });
  try {
    const stage = join(tmp, "b");
    await mkdir(stage);
    const names: string[] = [];
    for (const f of manifest.files) {
      if (!want.has(f.sha256)) continue;
      want.delete(f.sha256);
      // clone-or-copy, then re-hash the copy so a file edited mid-deploy can't upload mismatched content
      const dest = join(stage, f.sha256);
      await copyFile(join(root, ...f.path.split("/")), dest, fsConstants.COPYFILE_FICLONE);
      if ((await hashFile(dest)) !== f.sha256) {
        throw new PackError("file_changed", `${f.path} changed while deploying.`, "Wait for your editor/build to finish writing files, then call deploy again.");
      }
      names.push(f.sha256);
    }
    const file = join(tmp, "blobs.tar.gz");
    await tarCreate({ gzip: true, cwd: stage, file, portable: true, noDirRecurse: true }, names.length ? names : []);
    const bytes = (await stat(file)).size;
    if (bytes > maxBytes) {
      throw new PackError(
        "upload_too_large",
        `Changed files are ${formatMb(bytes)} compressed, over the ${formatMb(maxBytes)} upload limit.`,
        "Add large files, datasets or build outputs to .gitignore (or .rivtorignore), then call deploy again.",
      );
    }
    return { file, bytes, count: names.length, blob: () => openAsBlob(file, { type: "application/gzip" }), cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
