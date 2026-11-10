import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./cli.js";
import { parseEnvFile } from "./envfile.js";
import {
  defaultEnvFile,
  ensureGitignore,
  quoteEnvValue,
  renderEnvFile,
  writeEnvPull,
  type EnvExport,
} from "./envpull.js";
import { json, makeTree } from "./test/helpers.js";

const exported: EnvExport = {
  project: "shop",
  set: "local",
  service: null,
  vars: {
    DATABASE_URL: "postgresql://p_shop_tabc123:pw%2Fx@localhost:54329/p_shop",
    NEXT_PUBLIC_NAME: "My Shop #1",
    MULTI: 'line one\nline "two"',
  },
  omitted: [
    { key: "STRIPE_SECRET_KEY", reason: "sensitive" },
    { key: "REDIS_URL", reason: "not_reachable_locally" },
  ],
  comments: ["Postgres: reach it with `rivtor db connect --project shop`."],
  database: {
    host: "localhost",
    port: 54329,
    expiresAt: "2026-11-10T12:00:00.000Z",
  },
};

describe("env pull helpers", () => {
  it("picks .env.local for Next.js / Vite apps, else .env", async () => {
    expect(
      await defaultEnvFile(
        await makeTree({
          "package.json": JSON.stringify({ dependencies: { next: "15" } }),
        }),
      ),
    ).toBe(".env.local");
    expect(await defaultEnvFile(await makeTree({ "vite.config.ts": "" }))).toBe(
      ".env.local",
    );
    expect(
      await defaultEnvFile(await makeTree({ "requirements.txt": "fastapi" })),
    ).toBe(".env");
  });

  it("renders a file that parses back to the same values", () => {
    const text = renderEnvFile(exported, new Date("2026-11-10T11:00:00Z"));
    expect(text.split("\n")[0]).toContain("rivtor env pull");
    expect(text).toContain("# Postgres: reach it with");
    expect(parseEnvFile(text)).toEqual(exported.vars);
    expect(quoteEnvValue("plain-value_1")).toBe("plain-value_1");
  });

  it("adds .env* to .gitignore once, keeping !.env.example working", async () => {
    const dir = await makeTree({ ".gitignore": "node_modules\n!.env.example" });
    expect(await ensureGitignore(dir)).toBe(true);
    const text = await readFile(join(dir, ".gitignore"), "utf8");
    expect(text).toBe(
      "node_modules\n!.env.example\n\n# local env files (rivtor env pull)\n.env*\n!.env.example\n",
    );
    expect(await ensureGitignore(dir)).toBe(false);
    const fresh = await makeTree({});
    expect(await ensureGitignore(fresh)).toBe(true);
    expect(await readFile(join(fresh, ".gitignore"), "utf8")).toBe(
      "# local env files (rivtor env pull)\n.env*\n",
    );
  });
});

describe("env pull file writing", () => {
  it("never writes through a symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rv-envpull-link-"));
    const target = join(dir, "elsewhere.txt");
    await writeFile(target, "keep me");
    await symlink(target, join(dir, ".env"));
    await expect(writeEnvPull(join(dir, ".env"), exported, true)).rejects.toThrow(/symbolic link/);
    expect(await readFile(target, "utf8")).toBe("keep me");
  });
  it("--force leaves a fresh 0600 file even over a world-readable one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rv-envpull-mode-"));
    const path = join(dir, ".env");
    await writeFile(path, "OLD=1\n", { mode: 0o644 });
    await writeEnvPull(path, exported, true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(parseEnvFile(await readFile(path, "utf8")).NEXT_PUBLIC_NAME).toBe("My Shop #1");
  });
});

describe("rivtor env pull", () => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  let out = "";
  let calls: string[] = [];
  beforeEach(async () => {
    process.env.RIVTOR_CONFIG_DIR = await mkdtemp(
      join(tmpdir(), "rivtor-cfg-"),
    );
    process.env.RIVTOR_TOKEN = `rvt_${"a".repeat(40)}`;
    process.env.RIVTOR_API_URL = "https://api.test";
    out = "";
    calls = [];
    vi.spyOn(process.stdout, "write").mockImplementation(
      (s) => ((out += String(s)), true),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (s) => ((out += String(s)), true),
    );
    vi.stubGlobal("fetch", async (input: string | URL) => {
      calls.push(String(input));
      return json(exported);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.chdir(cwd);
    process.env = { ...saved };
    process.exitCode = undefined;
  });

  it("writes .env.local (0600), updates .gitignore and prints counts, never values", async () => {
    const dir = await makeTree({
      "package.json": JSON.stringify({
        name: "shop",
        dependencies: { next: "15" },
      }),
    });
    process.chdir(dir);
    await buildProgram("0.0.0").parseAsync([
      "node",
      "rivtor",
      "env",
      "pull",
      "--project",
      "shop",
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]).toBe(
      "https://api.test/v1/projects/shop/env/export?set=local&port=54329",
    );
    const file = join(dir, ".env.local");
    expect(parseEnvFile(await readFile(file, "utf8"))).toEqual(exported.vars);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".env*");
    expect(out).toContain("Wrote 3 vars to");
    expect(out).toContain("STRIPE_SECRET_KEY");
    expect(out).toContain("rivtor db connect");
    expect(out).not.toMatch(/pw%2Fx|My Shop|line one/);
  });

  it("refuses to overwrite without --force (before calling the API), and --production asks for that set", async () => {
    const dir = await makeTree({
      ".env": "KEEP=me\n",
      ".gitignore": ".env*\n",
    });
    process.chdir(dir);
    await buildProgram("0.0.0").parseAsync([
      "node",
      "rivtor",
      "env",
      "pull",
      "--project",
      "shop",
      "--production",
    ]);
    expect(process.exitCode).toBe(1);
    expect(out).toContain("--force");
    expect(calls).toHaveLength(0);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("KEEP=me\n");
    process.exitCode = undefined;
    await buildProgram("0.0.0").parseAsync([
      "node",
      "rivtor",
      "env",
      "pull",
      "--project",
      "shop",
      "--production",
      "--include-secrets",
      "--force",
      "--json",
    ]);
    expect(calls[0]).toBe(
      "https://api.test/v1/projects/shop/env/export?set=production&include_secrets=1&port=54329",
    );
    expect(parseEnvFile(await readFile(join(dir, ".env"), "utf8"))).toEqual(
      exported.vars,
    );
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(".env*\n");
    const summary = JSON.parse(out.slice(out.indexOf("{")));
    expect(summary).toMatchObject({
      file: ".env",
      written: 3,
      gitignoreUpdated: false,
    });
    expect(JSON.stringify(summary)).not.toContain("pw%2Fx");
  });

  it("rejects --local with --production", async () => {
    const dir = await makeTree({});
    process.chdir(dir);
    await writeFile(join(dir, "x"), "");
    await buildProgram("0.0.0").parseAsync([
      "node",
      "rivtor",
      "env",
      "pull",
      "--project",
      "shop",
      "--local",
      "--production",
    ]);
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
