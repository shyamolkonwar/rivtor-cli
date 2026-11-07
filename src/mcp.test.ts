import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ApiClient } from "./api.js";
import { TOOL_NAMES, createMcpServer, redactSecrets } from "./mcp.js";
import { json, makeTree, mockFetch, tarEntries } from "./test/helpers.js";

async function connect(handler: Parameters<typeof mockFetch>[0], token: string | null = "rvt_test") {
  const m = mockFetch(handler);
  const server = createMcpServer({
    getClient: async () => new ApiClient({ apiUrl: "https://api.test", token, fetch: m.fetch }),
    version: "9.9.9",
    sleep: async () => {},
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls: m.calls };
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;

describe("MCP server", () => {
  it("lists all tools with agent-facing descriptions", async () => {
    const { client } = await connect(() => json({}));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(40);
    const deploy = tools.find((t) => t.name === "deploy")!;
    expect(deploy.inputSchema.required).toEqual(["path"]);
    expect(Object.keys(deploy.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["path", "project", "dry_run", "env"]));
  });

  it("status proxies to the REST API", async () => {
    const { client, calls } = await connect(() => json({ slug: "shop", services: [] }));
    const res = await client.callTool({ name: "status", arguments: { project: "shop" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({ slug: "shop", services: [] });
    expect(calls[0].url).toBe("https://api.test/v1/projects/shop");
  });

  it("deploy dry_run packs locally and never uploads .env", async () => {
    const dir = await makeTree({ "package.json": "{}", ".env": "STRIPE_SECRET_KEY=sk_live_abc", "server.js": "x" });
    let form: FormData | null = null;
    let uploaded = new Uint8Array();
    const { client } = await connect(async (req) => {
      form = req.body as FormData;
      uploaded = new Uint8Array(await (form.get("source") as File).arrayBuffer());
      return json({ plan: { services: [], data: [], env: [], missingSecrets: [], assumptions: [], warnings: [] } });
    });
    const res = await client.callTool({ name: "deploy", arguments: { path: dir, project: "shop", dry_run: true, env: { A: "1" } } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toMatchObject({ status: "dry_run", project: "shop", files: 2 });
    expect(form!.get("dry_run")).toBe("true");
    expect(JSON.parse(form!.get("env") as string)).toEqual({ A: "1" });
    const entries = await tarEntries(uploaded);
    expect(entries).toEqual(["package.json", "server.js"]);
  });

  it("returns AgentErrors with isError and a login hint when not authenticated", async () => {
    const { client } = await connect(() => json({}), null);
    const res = await client.callTool({ name: "list_projects", arguments: {} });
    expect(res.isError).toBe(true);
    const err = JSON.parse(text(res));
    expect(err).toMatchObject({ code: "not_logged_in", stage: "auth" });
    expect(err.fix).toMatch(/RIVTOR_TOKEN/);
  });

  it("env_set never echoes values", async () => {
    const { client, calls } = await connect(() => json({ ok: true, vars: { STRIPE_SECRET_KEY: "sk_live_supersecret" } }));
    const res = await client.callTool({ name: "env_set", arguments: { project: "shop", vars: { STRIPE_SECRET_KEY: "sk_live_supersecret" }, remove: ["OLD"] } });
    expect(text(res)).not.toContain("supersecret");
    expect(JSON.parse(text(res))).toMatchObject({ set: ["STRIPE_SECRET_KEY"], removed: ["OLD"] });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE"]);
  });

  it("destroy is two-step", async () => {
    const { client, calls } = await connect((req) => (req.url.includes("confirm=") ? json({ destroyed: true }) : json({ confirm_token: "ct_1" })));
    const first = JSON.parse(text(await client.callTool({ name: "destroy", arguments: { project: "shop" } })));
    expect(first).toMatchObject({ confirm_token: "ct_1" });
    expect(first.next).toMatch(/confirm/);
    await client.callTool({ name: "destroy", arguments: { project: "shop", confirm_token: "ct_1" } });
    expect(calls[1].url).toBe("https://api.test/v1/projects/shop?confirm=ct_1");
  });

  it("passes API AgentErrors through", async () => {
    const agentError = { status: "failed", stage: "domain", code: "domain_limit", cause: "Free plan allows 1 custom domain", fix: "Upgrade, then call domain_add again", retryable: false };
    const { client } = await connect(() => json(agentError, 402));
    const res = await client.callTool({ name: "domain_add", arguments: { project: "shop", hostname: "Www.Example.com" } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(text(res))).toEqual(agentError);
  });
});

describe("redactSecrets", () => {
  it("masks tokens, URL passwords and stripe keys", () => {
    const s = redactSecrets('{"a":"rvt_abcdefghijkl","db":"postgresql://p_shop:hunter2@host:6432/db","k":"sk_live_1234567890"}');
    expect(s).not.toMatch(/abcdefghijkl|hunter2|1234567890/);
    expect(s).toContain("postgresql://p_shop:••••@host:6432/db");
  });
});
