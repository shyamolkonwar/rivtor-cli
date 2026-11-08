import type { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../cli.js";
import {
  bundledSkillDir,
  cursorRule,
  installSkill,
  parseSkillMd,
  skillDestination,
} from "./skills.js";

const saved = { ...process.env };
const savedCwd = process.cwd();
let home = "";
let project = "";
let out = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rivtor-home-"));
  project = await mkdtemp(join(tmpdir(), "rivtor-proj-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(project);
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation(
    (s) => ((out += String(s)), true),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(savedCwd);
  process.env = { ...saved };
  process.exitCode = undefined;
});

/** exitOverride on every command, so commander throws instead of exiting on usage errors. */
function program(): Command {
  const walk = (c: Command): void => {
    c.exitOverride();
    c.commands.forEach(walk);
  };
  const p = buildProgram("test");
  walk(p);
  return p;
}
const run = (...args: string[]) =>
  program().parseAsync(["node", "rivtor", "skills", ...args]);

describe("bundled skill", () => {
  it("has SKILL.md with name and description frontmatter, and every reference link resolves", async () => {
    const dir = bundledSkillDir();
    const md = await readFile(join(dir, "SKILL.md"), "utf8");
    const { fields, body } = parseSkillMd(md);
    expect(fields.name).toBe("rivtor");
    expect(fields.description.length).toBeGreaterThan(50);
    expect(fields.description.length).toBeLessThanOrEqual(1024);
    expect(fields.description).not.toMatch(/[<>]/);
    expect(body.split("\n").length).toBeLessThan(500);
    const links = [
      ...body.matchAll(/\]\((references\/[^)#]+)(?:#[^)]*)?\)/g),
    ].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of new Set(links))
      expect(existsSync(join(dir, link)), link).toBe(true);
  });
});

describe("rivtor skills install", () => {
  it("installs for Claude Code in ~/.claude/skills by default", async () => {
    await run("install");
    const dest = join(home, ".claude", "skills", "rivtor");
    expect(await readdir(dest)).toEqual(
      expect.arrayContaining(["SKILL.md", "references"]),
    );
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe(
      await readFile(join(bundledSkillDir(), "SKILL.md"), "utf8"),
    );
    expect(out).toContain(dest);
    expect(process.exitCode).toBe(0);
  });

  it("--project installs into ./.claude/skills", async () => {
    await run("install", "--target", "claude", "--project");
    expect(
      existsSync(join(project, ".claude", "skills", "rivtor", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("installs for Codex in ~/.agents/skills (or ./.agents/skills with --project)", async () => {
    await run("install", "--target", "codex");
    expect(
      existsSync(
        join(home, ".agents", "skills", "rivtor", "references", "errors.md"),
      ),
    ).toBe(true);
    await run("install", "--target", "codex", "--project");
    expect(
      existsSync(join(project, ".agents", "skills", "rivtor", "SKILL.md")),
    ).toBe(true);
  });

  it("generates a Cursor project rule with references next to it", async () => {
    await run("install", "--target", "cursor");
    const rule = await readFile(
      join(project, ".cursor", "rules", "rivtor.mdc"),
      "utf8",
    );
    expect(rule).toMatch(/^---\ndescription: ".+"\nalwaysApply: false\n---\n/);
    expect(rule).not.toContain("](references/");
    expect(rule).toContain("](rivtor/references/errors.md)");
    expect(
      existsSync(
        join(project, ".cursor", "rules", "rivtor", "references", "errors.md"),
      ),
    ).toBe(true);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  it("--target all installs every target and --json lists them", async () => {
    await run("install", "--target", "all", "--json");
    const res = JSON.parse(out) as {
      installed: Array<{ target: string; path: string }>;
    };
    expect(res.installed.map((i) => i.target)).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
    for (const i of res.installed) expect(existsSync(i.path)).toBe(true);
  });

  it("replaces an older install instead of merging into it", async () => {
    const dest = skillDestination("claude", { home });
    await installSkill("claude", { home });
    await writeFile(join(dest, "stale.md"), "old");
    await installSkill("claude", { home });
    expect(existsSync(join(dest, "stale.md"))).toBe(false);
  });

  it("rejects an unknown target", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(run("install", "--target", "vscode")).rejects.toThrow(
      /choices/i,
    );
  });
});

describe("rivtor skills path", () => {
  it("prints the bundled skill folder", async () => {
    await run("path");
    expect(out.trim()).toBe(bundledSkillDir());
  });
});

describe("cursorRule", () => {
  it("quotes the description and keeps the body", () => {
    const rule = cursorRule(
      '---\nname: x\ndescription: >-\n  Does a: thing\n  "well".\n---\n\n# X\n\nSee [r](references/a.md).\n',
    );
    expect(rule.split("\n").slice(0, 4)).toEqual([
      "---",
      'description: "Does a: thing \\"well\\"."',
      "alwaysApply: false",
      "---",
    ]);
    expect(rule).toContain("# X");
    expect(rule).toContain("[r](rivtor/references/a.md)");
  });
});
