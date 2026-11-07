import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectConfigError, SLUG_RE, readRivtorJson, resolveProject, sanitizeSlug, writeRivtorJson } from "./project.js";
import { makeTree } from "./test/helpers.js";

describe("sanitizeSlug", () => {
  it.each([
    ["my-app", "my-app"],
    ["My_Cool App", "my-cool-app"],
    ["  --weird--name--  ", "weird-name"],
    ["123-start", "app-123-start"],
    ["Café Résumé", "cafe-resume"],
    ["UPPER.case.js", "upper-case-js"],
    ["", "my-app"],
    ["___", "my-app"],
    ["日本語", "my-app"],
    ["a".repeat(50), "a".repeat(31)],
    ["abcdefghijklmnopqrstuvwxyz-1234-x", "abcdefghijklmnopqrstuvwxyz-1234"],
    ["abcdefghijklmnopqrstuvwxyz-12345-x", "abcdefghijklmnopqrstuvwxyz-1234"],
  ])("%j -> %j", (input, expected) => {
    const out = sanitizeSlug(input);
    expect(out).toBe(expected);
    expect(out).toMatch(SLUG_RE);
  });
});

describe("rivtor.json", () => {
  it("returns null when absent", async () => {
    expect(await readRivtorJson(await makeTree({}))).toBeNull();
  });

  it("reads a valid project", async () => {
    const dir = await makeTree({ "rivtor.json": '{"project":"shop"}' });
    expect(await readRivtorJson(dir)).toEqual({ project: "shop" });
  });

  it("rejects invalid JSON and invalid slugs with clear errors", async () => {
    await expect(readRivtorJson(await makeTree({ "rivtor.json": "{nope" }))).rejects.toThrow(/not valid JSON/);
    await expect(readRivtorJson(await makeTree({ "rivtor.json": '{"project":"Bad Slug"}' }))).rejects.toBeInstanceOf(ProjectConfigError);
    await expect(readRivtorJson(await makeTree({ "rivtor.json": "[1]" }))).rejects.toThrow(/JSON object/);
  });

  it("writes and preserves other keys", async () => {
    const dir = await makeTree({ "rivtor.json": '{"other": 1}' });
    await writeRivtorJson(dir, "shop");
    expect(JSON.parse(await readFile(join(dir, "rivtor.json"), "utf8"))).toEqual({ other: 1, project: "shop" });
  });
});

describe("resolveProject", () => {
  it("prefers --project, then rivtor.json, then folder name", async () => {
    const dir = await makeTree({}, "My Folder");
    expect(await resolveProject(dir)).toEqual({ slug: "my-folder", source: "folder" });
    await writeFile(join(dir, "rivtor.json"), '{"project":"from-json"}');
    expect(await resolveProject(dir)).toEqual({ slug: "from-json", source: "rivtor.json" });
    expect(await resolveProject(dir, "flagged")).toEqual({ slug: "flagged", source: "flag" });
  });

  it("validates the --project flag", async () => {
    await expect(resolveProject(await makeTree({}), "Not Valid")).rejects.toThrow(/not-valid/);
  });
});
