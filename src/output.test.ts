import { describe, expect, it } from "vitest";
import { exitCodeFor, formatAgentError, formatDeployResult, formatDuration, formatPlan } from "./output.js";

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("output", () => {
  it("maps statuses to exit codes", () => {
    expect(exitCodeFor("live")).toBe(0);
    expect(exitCodeFor("failed")).toBe(1);
    expect(exitCodeFor("needs_input")).toBe(2);
    expect(exitCodeFor(undefined)).toBe(1);
  });

  it("prints cause, file and fix of AgentErrors", () => {
    const s = strip(formatAgentError({ status: "failed", stage: "build", service: "api", code: "missing_python_module", cause: "Module 'stripe' not found", file: "api/payments.py:3", fix: "Add 'stripe' to api/requirements.txt, then call deploy again", retryable: true }));
    expect(s).toContain("build · api");
    expect(s).toContain("cause  Module 'stripe' not found");
    expect(s).toContain("file   api/payments.py:3");
    expect(s).toContain("fix    Add 'stripe'");
  });

  it("prints live results with URLs and needs_input with env set hints", () => {
    const live = strip(formatDeployResult({ status: "live", deploymentId: "d", project: "shop", urls: { web: "https://shop.rivtor.com" }, services: [], data: [], dashboardUrl: "https://rivtor.com/dashboard/projects/shop", durationMs: 95000 }));
    expect(live).toContain("✓ Live  shop in 1m 35s");
    expect(live).toContain("https://shop.rivtor.com");
    const needs = strip(
      formatDeployResult({
        status: "needs_input", deploymentId: "d", project: "shop", urls: {}, services: [], data: [], dashboardUrl: "", durationMs: 0,
        error: { status: "needs_input", stage: "plan", code: "missing_secrets", cause: "1 secret missing", fix: "Set it", retryable: true, missing: [{ name: "STRIPE_SECRET_KEY", service: "api", usedIn: ["api/pay.py:3"] }] },
      }),
    );
    expect(needs).toContain("STRIPE_SECRET_KEY (api) used in api/pay.py:3");
    expect(needs).toContain("rivtor env set STRIPE_SECRET_KEY=...");
  });

  it("prints plans with wiring and assumptions", () => {
    const s = strip(
      formatPlan(
        {
          services: [
            { name: "web", rootDir: "apps/web", kind: "web", runtime: "container", builder: "railpack", language: "node", framework: "nextjs", buildCommand: null, startCommand: null, outputDir: null, port: 3000, healthPath: "/", migrateCommand: null, dataNeeds: [], envNames: [], wiring: { NEXT_PUBLIC_API_URL: "api" }, public: true, contentHash: "" },
          ],
          data: ["postgres"],
          env: [{ service: "web", key: "NEXT_PUBLIC_API_URL", source: "wired", valuePreview: "https://shop-api.rivtor.com" }],
          missingSecrets: [],
          assumptions: [{ service: "api", message: "Assumed port 8000", override: "deploy.toml services.api.port" }],
          warnings: [],
        },
        "shop",
      ),
    );
    expect(s).toContain("web.NEXT_PUBLIC_API_URL → api");
    expect(s).toContain("Data  postgres");
    expect(s).toContain("[api] Assumed port 8000");
  });

  it("formats durations", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });
});
