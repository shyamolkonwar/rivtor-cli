import { describe, expect, it } from "vitest";
import { ApiClient, RivtorApiError, normalizeDeployment, normalizeLogs, parseErrorBody } from "./api.js";
import { json, mockFetch } from "./test/helpers.js";

const fails = (p: Promise<unknown>): Promise<RivtorApiError> =>
  p.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (e: RivtorApiError) => e,
  );

const client = (fetchImpl: ReturnType<typeof mockFetch>["fetch"], token: string | null = "rvt_test_token_123") =>
  new ApiClient({ apiUrl: "https://api.example.test/", token, fetch: fetchImpl });

describe("ApiClient", () => {
  it("sends bearer auth and parses JSON", async () => {
    const m = mockFetch(() => json({ email: "a@b.c" }));
    const res = await client(m.fetch).me();
    expect(res).toEqual({ email: "a@b.c" });
    expect(m.calls[0].url).toBe("https://api.example.test/v1/me");
    expect(m.calls[0].headers.authorization).toBe("Bearer rvt_test_token_123");
  });

  it("fails fast without a token and never calls the network", async () => {
    const m = mockFetch(() => json({}));
    const err = await fails(client(m.fetch, null).listProjects());
    expect(err).toBeInstanceOf(RivtorApiError);
    expect(err.agentError.code).toBe("not_logged_in");
    expect(err.agentError.cause).toMatch(/rivtor login/);
    expect(m.calls).toHaveLength(0);
  });

  it("surfaces AgentError bodies unchanged", async () => {
    const agentError = {
      status: "failed",
      stage: "limits",
      code: "project_limit",
      cause: "Free plan allows 3 projects",
      fix: "Delete a project or upgrade, then call deploy again",
      retryable: false,
      upgrade: { trigger: "projects", message: "Upgrade", plan: "hobby", url: "https://pay" },
    };
    const m = mockFetch(() => json(agentError, 402));
    const err = await fails(client(m.fetch).getProject("x"));
    expect(err).toBeInstanceOf(RivtorApiError);
    expect(err.status).toBe(402);
    expect(err.agentError).toEqual(agentError);
  });

  it("unwraps { error: AgentError }", async () => {
    const m = mockFetch(() => json({ error: { code: "x", cause: "c", fix: "f", retryable: false } }, 400));
    const err = await fails(client(m.fetch).getProject("x"));
    expect(err.agentError).toMatchObject({ code: "x", cause: "c", fix: "f", stage: "return" });
  });

  it("handles non-JSON 502 from a proxy", async () => {
    const m = mockFetch(() => new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502 }));
    const err = await fails(client(m.fetch).envList("x"));
    expect(err.agentError).toMatchObject({ code: "http_502", stage: "env", retryable: true });
    expect(err.agentError.cause).toContain("502 Bad Gateway");
    expect(err.agentError.cause).not.toContain("<html>");
  });

  it("maps 401 without a body to a login hint", async () => {
    const m = mockFetch(() => new Response("", { status: 401 }));
    const err = await fails(client(m.fetch).me());
    expect(err.agentError).toMatchObject({ code: "unauthorized", stage: "auth", retryable: false });
    expect(err.agentError.fix).toMatch(/rivtor login/);
  });

  it("maps network errors", async () => {
    const fetchImpl = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    };
    const err = await fails(new ApiClient({ apiUrl: "https://nope.test", token: "rvt_x", fetch: fetchImpl }).me());
    expect(err.agentError).toMatchObject({ code: "network_error", retryable: true });
    expect(err.agentError.cause).toContain("ENOTFOUND");
    expect(err.agentError.cause).toContain("https://nope.test");
  });

  it("maps 404 and 429", () => {
    expect(parseErrorBody(404, "", "return")).toMatchObject({ code: "not_found", retryable: false });
    expect(parseErrorBody(429, '{"message":"slow down"}', "return")).toMatchObject({ code: "rate_limited", cause: "slow down", retryable: true });
  });

  it("encodes path segments and drops empty query params", async () => {
    const m = mockFetch(() => json([]));
    await client(m.fetch).projectLogs("a/b", { service: "api", since: "", level: undefined, limit: 5 });
    expect(m.calls[0].url).toBe("https://api.example.test/v1/projects/a%2Fb/logs?service=api&limit=5");
  });

  it("sends env removals as a JSON body on DELETE", async () => {
    const m = mockFetch(() => new Response(null, { status: 204 }));
    await client(m.fetch).envRemove("shop", ["A", "B"], "api");
    expect(m.calls[0].method).toBe("DELETE");
    expect(JSON.parse(m.calls[0].body as string)).toEqual({ keys: ["A", "B"], service: "api" });
  });
});

describe("normalizeDeployment", () => {
  const result = { status: "live", deploymentId: "d1", project: "p", urls: { web: "https://p.rivtor.com" }, services: [], data: [], dashboardUrl: "", durationMs: 1 };
  it("handles flat in-progress deployments", () => {
    expect(normalizeDeployment({ id: "d1", status: "build" }, "d1")).toMatchObject({ terminal: false, stage: "build", result: null });
  });
  it("handles wrapped deployments with results", () => {
    expect(normalizeDeployment({ deployment: { id: "d1", status: "live", result } }, "x")).toMatchObject({ id: "d1", terminal: true, result });
  });
  it("treats a bare DeployResult as terminal", () => {
    expect(normalizeDeployment(result, "d1")).toMatchObject({ terminal: true, status: "live" });
  });
  it("treats cancelled as terminal", () => {
    expect(normalizeDeployment({ status: "cancelled" }, "d1")).toMatchObject({ terminal: true, id: "d1" });
  });
});

describe("normalizeLogs", () => {
  it("accepts several shapes", () => {
    expect(normalizeLogs({ logs: [{ id: 3, stage: "build", message: "hi" }] })).toMatchObject({ cursor: 3, lines: [{ stage: "build", message: "hi" }] });
    expect(normalizeLogs([{ id: "a", line: "x" }, { id: "b", text: "y" }]).cursor).toBe("b");
    expect(normalizeLogs({ lines: [], next: 9 }).cursor).toBe(9);
    expect(normalizeLogs("a\nb").lines.map((l) => l.message)).toEqual(["a", "b"]);
  });
});
