import { afterEach, expect, it, vi } from "vitest";
import { buildProgram } from "../cli.js";
import { json, mockFetch } from "../test/helpers.js";
const saved = { ...process.env };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); process.env = { ...saved }; process.exitCode = undefined; });
function setup() {
  process.env.RIVTOR_TOKEN = "fixture-token"; process.env.RIVTOR_API_URL = "https://api.test";
  const m = mockFetch(() => json({ issues: [], ok: true })); vi.stubGlobal("fetch", m.fetch);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return m;
}
it("lists and resolves issues through the authenticated project API", async () => {
  const m = setup();
  await buildProgram("test").exitOverride().parseAsync(["node", "rivtor", "issues", "shop", "--status", "open", "--json"]);
  expect(m.calls[0].url).toBe("https://api.test/v1/projects/shop/issues?status=open");
  await buildProgram("test").exitOverride().parseAsync(["node", "rivtor", "issue-resolve", "11111111-1111-4111-8111-111111111111", "--project", "shop", "--dismiss", "--json"]);
  expect(m.calls[1]).toMatchObject({ method: "POST", body: JSON.stringify({ status: "dismissed" }) });
});
it("requires explicit consent before requesting an automatic fix", async () => {
  const m = setup();
  const args = ["node", "rivtor", "verify-fix", "11111111-1111-4111-8111-111111111111", "--project", "shop", "--json"];
  await buildProgram("test").exitOverride().parseAsync(args);
  expect(process.exitCode).toBe(1); expect(m.calls).toHaveLength(0);
  await buildProgram("test").exitOverride().parseAsync([...args, "--yes"]);
  expect(m.calls[0]).toMatchObject({ method: "POST", url: "https://api.test/v1/projects/shop/verify-fix", body: JSON.stringify({ consent: true, issue_ids: ["11111111-1111-4111-8111-111111111111"] }) });
});
