// Verified deploys: report contract shared by the control plane, CLI/MCP and the dashboard
// (spec: "Report format", "Checks", "Production watch").

export type Verdict = "working" | "partly_working" | "broken";
export type CheckGroup =
  "reachability" | "pages" | "api" | "data" | "config" | "security" | "journey";
export type IssueSeverity = "critical" | "warning" | "info";

/** One problem found by a check, written for the agent to act on. */
export interface VerifyIssue {
  severity: IssueSeverity;
  check: CheckGroup;
  /** "GET /dashboard → 500", "NEXTAUTH_URL", "web/.next/static/chunks/app.js" */
  where: string;
  cause: string;
  /** source location when known: "web/lib/stripe.ts:4" */
  file?: string;
  fix: string;
  auto_fixable: boolean;
  /** stable machine code, e.g. "page_5xx", "cors_blocked", "client_secret" */
  code: string;
  service?: string;
  /** set when the issue is linked to a persistent project issue (issues tool) */
  issue_id?: string;
  /** machine-readable fix for verify_fix (never contains secret values) */
  fix_action?: VerifyFixAction;
  /** true for findings on the home page / API / database: they make the verdict "broken" */
  blocking?: boolean;
}

export type VerifyFixAction =
  | { kind: "set_env_url"; service: string; key: string; value: string }
  | { kind: "cors_origin"; service: string; origin: string }
  | { kind: "security_headers"; service: string };

export interface VerifyCheckCounts {
  passed: number;
  warnings: number;
  failed: number;
}

export interface VerifyPageResult {
  service: string;
  path: string;
  status: number | null;
  ms: number;
  ok: boolean;
  screenshot?: string;
  consoleErrors?: number;
  failedRequests?: number;
}

/** Returned at the end of every `deploy` (unless verify:false) and by `verify`. */
export interface VerificationReport {
  id: string;
  verdict: Verdict;
  summary: string;
  urls: Record<string, string>;
  checks: VerifyCheckCounts;
  issues: VerifyIssue[];
  screenshots: string[];
  report_url: string;
  /** candidate = probed before traffic switched; live = public URLs */
  mode: "candidate" | "live";
  trigger:
    | "deploy"
    | "manual"
    | "scheduled"
    | "env_change"
    | "migration"
    | "fix"
    | "journey";
  durationMs: number;
  /** groups that ran / were skipped (with the reason) so nothing is silently dropped */
  groups: Array<{
    group: CheckGroup;
    ran: boolean;
    reason?: string;
    passed: number;
    failed: number;
    warnings: number;
  }>;
  pages?: VerifyPageResult[];
  /** release blocked and previous release kept serving (verdict broken or exposed secret) */
  blocked?: boolean;
  createdAt: string;
}

/** Persistent project issue (production + security + verification), `issues` tool. */
export interface ProjectIssue {
  id: string;
  project: string;
  source: "verify" | "production" | "security" | "browser";
  severity: IssueSeverity;
  status: "open" | "resolved" | "dismissed";
  check: string;
  service: string | null;
  where: string;
  cause: string;
  file: string | null;
  fix: string;
  release: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  stack?: string[];
  request?: { method: string; path: string; status: number; ms: number };
  rollbackHint?: string;
}

export interface VerifySummary {
  verdict: Verdict | null;
  report_url: string | null;
  at: string | null;
  openIssues: number;
}

export const VERIFY_LIMITS = {
  /** deploy waits at most this long for verification (spec: "up to 60 s") */
  deployWaitMs: 60_000,
  /** home page + up to 10 discovered routes */
  maxPages: 11,
  maxApiRoutes: 15,
  /** "a few requests per second" */
  requestsPerSecond: 4,
  requestTimeoutMs: 8_000,
  maxRedirects: 5,
  maxBodyBytes: 2 * 1024 * 1024,
  userAgent: "rivtor-verify/1.0 (+https://rivtor.com/docs/verify)",
} as const;

/** Production re-check interval per plan (null = no production watch). */
export const RECHECK_INTERVAL_MS: Record<
  "free" | "hobby" | "pro" | "team",
  number | null
> = {
  free: null,
  hobby: 24 * 60 * 60_000,
  pro: 15 * 60_000,
  team: 5 * 60_000,
};

export const ERROR_RETENTION_DAYS: Record<
  "free" | "hobby" | "pro" | "team",
  number
> = {
  free: 0,
  hobby: 7,
  pro: 30,
  team: 90,
};

export const JOURNEY_LIMIT: Record<"free" | "hobby" | "pro" | "team", number> =
  {
    free: 0,
    hobby: 0,
    pro: 5,
    team: 25,
  };
