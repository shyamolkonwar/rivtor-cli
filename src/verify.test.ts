import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerificationReport, DeployResult } from "./shared.js";
import { ApiClient } from "./api.js";
import { runDeploy } from "./deploy.js";
import { formatDeployResult } from "./output.js";
import { buildProgram } from "./cli.js";
import { json, makeTree, mockFetch } from "./test/helpers.js";

const report: VerificationReport = {
  id: "11111111-1111-4111-8111-111111111111", verdict: "partly_working", summary: "Dashboard needs attention.",
  urls: {}, checks: { passed: 4, warnings: 1, failed: 1 }, issues: [{ severity: "critical", check: "config", where: "PAYMENT_KEY", cause: "Missing variable", file: "app.ts:2", fix: "Set PAYMENT_KEY and redeploy", auto_fixable: false, code: "missing_env" }],
  screenshots: [], report_url: "https://rivtor.com/r/11111111-1111-4111-8111-111111111111", mode: "live", trigger: "manual", durationMs: 1500, groups: [], createdAt: "2026-11-08T00:00:00Z",
};
const saved = { ...process.env };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); process.env = { ...saved }; process.exitCode = undefined; });

describe("verified deploy surfaces", () => {
  it("renders the actual report and distinguishes skipped from missing", () => {
    const base = { status: "live", project: "test", services: [], data: [], urls: {}, durationMs: 100 } as unknown as DeployResult;
    const out = formatDeployResult({ ...base, verification: report });
    expect(out).toContain("Partly working");
    for (const field of [report.summary, "4 passed", "1 warning", "1 failed", "Missing variable", "app.ts:2", "Set PAYMENT_KEY and redeploy", report.report_url]) expect(out).toContain(field);
    expect(formatDeployResult({ ...base, verificationSkipped: true })).toContain("Verification skipped");
    expect(formatDeployResult(base)).toContain("No verification report");
  });

  it.each(["tar", "fallback", "blobs", "manifest"])("forwards verify:false through %s upload without changing other options", async (mode) => {
    const dir = await makeTree({ "index.html": "hello" });
    const m = mockFetch(req => {
      if (req.url.endsWith("/uploads/manifest")) {
        if (mode === "fallback") return json({}, 404);
        const manifest = JSON.parse(String(req.body));
        return json({ manifestId: "a".repeat(32), missing: mode === "blobs" ? [manifest.files[0].sha256] : [] });
      }
      return json({ deploymentId: "d" }, 202);
    });
    await runDeploy(new ApiClient({ apiUrl: "https://api.test", token: "test", fetch: m.fetch }), { dir, wait: false, saveProject: false, incremental: mode !== "tar", verify: false, clean: true });
    const body = m.calls.at(-1)!.body;
    if (body instanceof FormData) { expect(body.get("verify")).toBe("false"); expect(body.get("clean")).toBe("true"); }
    else expect(JSON.parse(String(body))).toMatchObject({ verify: false, clean: true, wait: false });
  });

  it("deploy parser forwards --no-verify rather than confusing it with --no-wait", async () => {
    process.env.RIVTOR_TOKEN = "fixture-token"; process.env.RIVTOR_API_URL = "https://api.test";
    const dir = await makeTree({ "index.html": "test" });
    const m = mockFetch(req => req.url.endsWith("/uploads/manifest") ? json({},404) : json({ deploymentId: "d" },202));
    vi.stubGlobal("fetch", m.fetch); vi.spyOn(process.stdout,"write").mockImplementation(()=>true);
    await buildProgram("test").parseAsync(["node","rivtor","deploy",dir,"--project","test","--no-verify","--no-wait","--json"]);
    expect((m.calls.at(-1)!.body as FormData).get("verify")).toBe("false");
    expect(process.exitCode).toBe(0);
  });

  it("status reports the API verdict and open issue count", async () => {
    process.env.RIVTOR_TOKEN = "fixture-token"; process.env.RIVTOR_API_URL = "https://api.test";
    vi.stubGlobal("fetch", mockFetch(()=>json({ verification:{verdict:"broken",openIssues:3,at:report.createdAt,report_url:report.report_url} })).fetch);
    let out=""; vi.spyOn(process.stdout,"write").mockImplementation(s=>{out+=String(s);return true;});
    await buildProgram("test").parseAsync(["node","rivtor","status","shop"]);
    expect(out).toContain("Verification: Broken · 3 open issues"); expect(out).toContain(report.report_url);
  });

  it("verify errors preserve structured auth errors rather than a success verdict", async () => {
    process.env.RIVTOR_TOKEN = "fixture-token"; process.env.RIVTOR_API_URL = "https://api.test";
    vi.stubGlobal("fetch",mockFetch(()=>json({},401)).fetch);
    let out="";vi.spyOn(process.stdout,"write").mockImplementation(s=>{out+=String(s);return true;});
    await buildProgram("test").parseAsync(["node","rivtor","verify","shop","--json"]);
    expect(JSON.parse(out)).toMatchObject({code:"unauthorized",status:"failed"});expect(process.exitCode).toBe(1);
  });

  it("verify --json posts an empty object to the encoded project route", async () => {
    process.env.RIVTOR_TOKEN = "fixture-token"; process.env.RIVTOR_API_URL = "https://api.test";
    const m = mockFetch(() => json(report)); vi.stubGlobal("fetch", m.fetch);
    let out = ""; vi.spyOn(process.stdout, "write").mockImplementation(s => { out += String(s); return true; });
    await buildProgram("test").parseAsync(["node", "rivtor", "verify", "shop", "--json"]);
    expect(m.calls[0]).toMatchObject({ url: "https://api.test/v1/projects/shop/verify", method: "POST", body: "{}" });
    expect(JSON.parse(out)).toEqual(report);
    expect(process.exitCode).toBe(1);
    vi.unstubAllGlobals();
  });
});
