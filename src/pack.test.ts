import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PackError, isAlwaysExcluded, listFiles, packDir } from "./pack.js";
import { makeTree, tarEntries } from "./test/helpers.js";

describe("isAlwaysExcluded", () => {
  it("excludes every .env* except documented examples", () => {
    for (const n of [".env", ".env.local", ".env.production", ".env.development.local", ".envrc", ".env.test"]) {
      expect(isAlwaysExcluded(n), n).toBe(true);
    }
    for (const n of [".env.example", ".env.sample", ".env.template", "env.ts", "config.env.ts", ".environment-notes"]) {
      // ".environment-notes" starts with ".env" so it is excluded too (conservative)
      expect(isAlwaysExcluded(n), n).toBe(n === ".environment-notes");
    }
  });
});

describe("listFiles", () => {
  it("applies default ignores, nested .gitignore, negations and always drops env files", async () => {
    const root = await makeTree({
      "package.json": "{}",
      ".env": "SECRET=1",
      ".env.local": "SECRET=2",
      ".env.production": "SECRET=3",
      ".env.example": "SECRET=",
      ".env.sample": "X=",
      ".gitignore": "*.secret\nlogs/\n!keep.secret\n",
      "a.secret": "x",
      "keep.secret": "kept by negation",
      "logs/app.txt": "x",
      "debug.log": "x",
      "node_modules/react/index.js": "x",
      "dist/out.js": "x",
      ".next/cache/x": "x",
      ".git/HEAD": "ref",
      "src/index.ts": "x",
      "apps/api/.gitignore": "tmp/\n",
      "apps/api/tmp/scratch.txt": "x",
      "apps/api/main.py": "x",
      "apps/api/.env": "API_SECRET=1",
      "apps/api/.env.example": "API_SECRET=",
      "apps/api/__pycache__/main.cpython-312.pyc": "x",
      "apps/api/.venv/bin/python": "x",
      "apps/web/.gitignore": "!.env.local\n", // cannot re-include env files
      "apps/web/.env.local": "WEB_SECRET=1",
      "apps/web/index.html": "<html>",
    });
    const files = await listFiles(root);
    expect(files).toEqual([
      ".env.example",
      ".env.sample",
      ".gitignore",
      "apps/api/.env.example",
      "apps/api/.gitignore",
      "apps/api/main.py",
      "apps/web/.gitignore",
      "apps/web/index.html",
      "keep.secret",
      "package.json",
      "src/index.ts",
    ]);
  });

  it("lets a .gitignore negation re-include a default-ignored build folder", async () => {
    const root = await makeTree({ ".gitignore": "!build/\n", "build/keep.txt": "x", "dist/x.js": "x" });
    expect(await listFiles(root)).toEqual([".gitignore", "build/keep.txt"]);
  });

  it("supports extra ignores and .rivtorignore", async () => {
    const root = await makeTree({ ".rivtorignore": "data/\n", "data/big.csv": "x", "fixtures/a.json": "x", "main.go": "x" });
    expect(await listFiles(root, { extraIgnores: ["fixtures/"] })).toEqual([".rivtorignore", "main.go"]);
  });

  it("throws a PackError for a missing directory", async () => {
    await expect(listFiles("/definitely/not/here")).rejects.toBeInstanceOf(PackError);
  });
});

describe("packDir", () => {
  it("produces a tar.gz with exactly the listed files and no env secrets", async () => {
    const root = await makeTree({
      "package.json": '{"name":"x"}',
      ".env": "SECRET=1",
      ".env.example": "SECRET=",
      "src/a.ts": "export {}",
      "node_modules/x/index.js": "x",
    });
    const pack = await packDir(root);
    try {
      expect(pack.files).toEqual([".env.example", "package.json", "src/a.ts"]);
      expect(pack.bytes).toBeGreaterThan(0);
      const entries = await tarEntries(new Uint8Array(await (await pack.blob()).arrayBuffer()));
      expect(entries).toEqual([".env.example", "package.json", "src/a.ts"]);
      expect(entries).not.toContain(".env");
    } finally {
      await pack.cleanup();
    }
  });

  it("enforces the size limit with a helpful message", async () => {
    const root = await makeTree({ "index.html": "<html>" });
    await mkdir(join(root, "assets"));
    // random data does not compress
    const big = Buffer.alloc(64 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    await writeFile(join(root, "assets", "video.bin"), big);
    const err = await packDir(root, { maxBytes: 1024 }).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(err.code).toBe("upload_too_large");
    expect(err.message).toContain("assets/video.bin");
    expect(err.fix).toMatch(/\.gitignore/);
  });

  it("rejects empty projects", async () => {
    const root = await makeTree({ ".env": "A=1", "node_modules/a.js": "x" });
    await expect(packDir(root)).rejects.toMatchObject({ code: "empty_project" });
  });

  it("cleans up its temp file", async () => {
    const root = await makeTree({ "a.txt": "a" });
    const pack = await packDir(root);
    await pack.cleanup();
    await expect(readFile(pack.file)).rejects.toThrow();
  });
});
