import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiClient } from "./api.js";
import { type ProgressEvent, runDeploy } from "./deploy.js";
import { json, makeTree, mockFetch, tarEntries } from "./test/helpers.js";

const noSleep = async () => {};

const plan = {
  services: [{ name: "web", rootDir: ".", kind: "static", runtime: "edge", builder: "static", language: "node", framework: "vite", buildCommand: "npm run build", startCommand: null, outputDir: "dist", port: null, healthPath: "/", migrateCommand: null, dataNeeds: [], envNames: [], wiring: {}, public: true, contentHash: "x" }],
  data: [],
  env: [],
  missingSecrets: [],
  assumptions: [],
  warnings: [],
};

describe("runDeploy", () => {
  it("dry run uploads multipart without .env and never writes rivtor.json", async () => {
    const dir = await makeTree({ "package.json": "{}", ".env": "SECRET=1", ".env.local": "S=2", "index.html": "<html>" }, "Shop Front");
    let form: FormData | null = null;
    let uploaded = new Uint8Array();
    const m = mockFetch(async (req) => {
      form = req.body as FormData;
      // the temp tarball is deleted after the request completes, so read it inside the handler
      uploaded = new Uint8Array(await (form.get("source") as File).arrayBuffer());
      return json({ plan });
    });
    const client = new ApiClient({ apiUrl: "https://api.test", token: "rvt_t", fetch: m.fetch });
    const out = await runDeploy(client, { dir, dryRun: true });
    expect(out.kind).toBe("plan");
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].url).toBe("https://api.test/v1/projects/shop-front/deployments");
    expect(form!.get("dry_run")).toBe("true");
    expect(form!.get("wait")).toBe("true");
    expect(form!.get("env")).toBeNull();
    expect((form!.get("source") as File).name).toBe("source.tar.gz");
    const entries = await tarEntries(uploaded);
    expect(entries).toEqual(["index.html", "package.json"]);
    await expect(readFile(join(dir, "rivtor.json"))).rejects.toThrow();
  });

  it("starts async, polls with progress and writes rivtor.json", async () => {
    const dir = await makeTree({ "main.py": "print(1)" }, "api-thing");
    const result = { status: "live", deploymentId: "dep_1", project: "api-thing", urls: { app: "https://api-thing.rivtor.com" }, services: [], data: [], dashboardUrl: "https://rivtor.com/dashboard", durationMs: 1000 };
    const states = [{ id: "dep_1", status: "build" }, { id: "dep_1", status: "release" }, { deployment: { id: "dep_1", status: "live", result } }];
    let poll = 0;
    let form: FormData | null = null;
    const m = mockFetch((req) => {
      if (req.method === "POST") {
        form = req.body as FormData;
        return json({ deploymentId: "dep_1" }, 202);
      }
      if (req.url.includes("/logs")) {
        return json({ logs: poll === 1 ? [{ id: 1, stage: "build", message: "installing deps" }] : [] });
      }
      return json(states[Math.min(poll++, states.length - 1)]);
    });
    const events: ProgressEvent[] = [];
    const client = new ApiClient({ apiUrl: "https://api.test", token: "rvt_t", fetch: m.fetch });
    const out = await runDeploy(client, { dir, env: { STRIPE_KEY: "sk" }, onProgress: (e) => events.push(e), sleep: noSleep });
    expect(out.kind).toBe("result");
    if (out.kind === "result") expect(out.result.status).toBe("live");
    expect(form!.get("wait")).toBe("false");
    expect(JSON.parse(form!.get("env") as string)).toEqual({ STRIPE_KEY: "sk" });
    expect(events.filter((e) => e.type === "stage").map((e) => (e as { stage: string }).stage)).toEqual(["build", "release"]);
    expect(events.some((e) => e.type === "log")).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "rivtor.json"), "utf8"))).toEqual({ project: "api-thing" });
    // logs are requested after the last seen id
    expect(m.calls.some((c) => c.url.endsWith("/logs?after=1"))).toBe(true);
  });

  it("returns immediately with --no-wait", async () => {
    const dir = await makeTree({ "a.txt": "x" });
    const m = mockFetch(() => json({ deployment: { id: "dep_9" } }));
    const out = await runDeploy(new ApiClient({ apiUrl: "https://api.test", token: "rvt_t", fetch: m.fetch }), { dir, wait: false, project: "named" });
    expect(out).toMatchObject({ kind: "started", deploymentId: "dep_9", project: { slug: "named" } });
    expect(m.calls).toHaveLength(1);
  });

  it("synthesises a failed result when the API reports failure without one", async () => {
    const dir = await makeTree({ "a.txt": "x" });
    const m = mockFetch((req) => (req.method === "POST" ? json({ id: "d" }) : req.url.includes("/logs") ? json([]) : json({ status: "failed" })));
    const out = await runDeploy(new ApiClient({ apiUrl: "https://api.test", token: "rvt_t", fetch: m.fetch }), { dir, sleep: noSleep });
    expect(out.kind === "result" && out.result.status).toBe("failed");
    expect(out.kind === "result" && out.result.error?.fix).toMatch(/rivtor logs --build d/);
  });

  it("rides out transient poll failures", async () => {
    const dir = await makeTree({ "a.txt": "x" });
    let n = 0;
    const m = mockFetch((req) => {
      if (req.method === "POST") return json({ deploymentId: "d" });
      if (req.url.includes("/logs")) return json([]);
      n++;
      return n < 3 ? new Response("bad gateway", { status: 502 }) : json({ status: "live", deploymentId: "d", urls: {} });
    });
    const out = await runDeploy(new ApiClient({ apiUrl: "https://api.test", token: "rvt_t", fetch: m.fetch }), { dir, sleep: noSleep });
    expect(out.kind === "result" && out.result.status).toBe("live");
  });

  it("fails fast before packing when not logged in", async () => {
    const m = mockFetch(() => json({}));
    await expect(runDeploy(new ApiClient({ apiUrl: "https://api.test", token: null, fetch: m.fetch }), { dir: "/does/not/exist" })).rejects.toMatchObject({
      agentError: { code: "not_logged_in" },
    });
  });
});
