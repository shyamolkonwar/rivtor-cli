import { expect, it } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { readImportConfigs, readImportInput, registerImport, importActionRequest, uploadImportSource, waitForImportOperation } from "./import.js";
it("reads only named provider config files and refuses symlinks", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "import-cli-test-"));
  try {
    await writeFile(join(dir, "vercel.json"), "{}"); await writeFile(join(dir, ".env"), "DO_NOT_READ=secret");
    expect(await readImportConfigs(dir)).toEqual({ "vercel.json": "{}" });
    await writeFile(join(dir, "input.json"), '{"data":{"postgres":{"sourceUrl":"private-input"}}}');
    expect((await readImportInput(join(dir, "input.json"))).data).toEqual({ postgres: { sourceUrl: "private-input" } });
    await writeFile(join(dir, "index.js"), "console.log('app')");
    let files: string[] = [];
    await uploadImportSource({ uploadManifest: async (_slug: string, manifest: { files: { path: string }[] }) => { files = manifest.files.map(f => f.path); return { manifestId: "a".repeat(32), missing: [] }; } } as any, dir, "app", join(dir, "input.json"));
    expect(files).toEqual(["index.js"]);
    await symlink(".env", join(dir, "render.yaml"));
    await expect(readImportConfigs(dir)).rejects.toThrow(/symlink/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("registers import lifecycle commands without changing existing registrations", () => {
  const program = new Command(); registerImport(program);
  const command = program.commands.find(c => c.name() === "import")!;
  expect(command.commands.map(c => c.name())).toEqual(expect.arrayContaining(["status", "approve", "deploy", "copy", "sync", "cutover", "undo"]));
});
it("uses digest/revision-bound JSON approvals and explicit DNS-only undo acknowledgement", async () => {
  const calls: unknown[] = [];
  const client = { async request(method: string, path: string, options?: unknown) { calls.push({ method, path, options }); return { state: "undone" }; } };
  await importActionRequest(client, "app", "123", "undo", { revision: 4, planDigest: "digest" }, true);
  expect(calls).toEqual([{ method: "POST", path: "/v1/projects/app/imports/123/undo", options: expect.objectContaining({ json: { expectedRevision: 4, planDigest: "digest", approve: true, acknowledgeDnsOnlyUndo: true } }) }]);
});
it("polls processing phases with reads rather than replaying mutations", async () => {
  const methods: string[] = [];
  const initial = { id: "job", revision: 1, planDigest: "digest", state: "deploying", operation: { id: "operation" } };
  const client = { async request(method: string) { methods.push(method); return { ...initial, revision: 2, state: "deployed", operation: undefined }; } };
  const result = await waitForImportOperation(client, "app", initial, { sleep: async () => {} });
  expect(result.state).toBe("deployed");
  expect(result.revision).toBe(2);
  expect(methods).toEqual(["GET"]);
});
it("keeps timed-out operations pending instead of replaying them", async () => {
  const client = { async request() { throw Error("Must not be called"); } };
  await expect(waitForImportOperation(client, "app", { id: "job", revision: 1, planDigest: "digest", state: "deploying", operation: { id: "operation" } }, { timeoutMs: 0 })).rejects.toThrow(/still running/);
});
