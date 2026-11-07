import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./cli.js";
import { parseAssignments } from "./commands/env.js";
import { looksLikeToken } from "./commands/auth.js";
import { makeTree } from "./test/helpers.js";

describe("rivtor deploy without a token", () => {
  const saved = { ...process.env };
  let out = "";
  let err = "";
  beforeEach(async () => {
    process.env.RIVTOR_CONFIG_DIR = await mkdtemp(join(tmpdir(), "rivtor-cfg-"));
    delete process.env.RIVTOR_TOKEN;
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
    process.exitCode = undefined;
  });

  it("--json prints an AgentError and exits 1 without touching the folder", async () => {
    const dir = await makeTree({ "index.html": "x" });
    await buildProgram("0.0.0").parseAsync(["node", "rivtor", "deploy", dir, "--dry-run", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: "failed", stage: "auth", code: "not_logged_in" });
    expect(await readdir(dir)).toEqual(["index.html"]);
  });

  it("human output explains how to log in", async () => {
    const dir = await makeTree({ "index.html": "x" });
    await buildProgram("0.0.0").parseAsync(["node", "rivtor", "deploy", dir]);
    expect(process.exitCode).toBe(1);
    expect(err).toContain("rivtor login");
    expect(err).toContain("https://rivtor.com/dashboard/tokens");
  });
});

describe("helpers", () => {
  it("parses KEY=VALUE pairs (values may contain =)", () => {
    expect(parseAssignments(["A=1", "B=x=y", "C="])).toEqual({ A: "1", B: "x=y", C: "" });
    expect(() => parseAssignments(["NOPE"])).toThrow(/KEY=VALUE/);
    expect(() => parseAssignments(["1BAD=x"])).toThrow(/valid env var/);
  });

  it("recognises tokens loosely", () => {
    expect(looksLikeToken("rvt_" + "a".repeat(40))).toBe(true);
    expect(looksLikeToken("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl")).toBe(true);
    expect(looksLikeToken("hello")).toBe(false);
    expect(looksLikeToken("rvt_ has space")).toBe(false);
  });
});
