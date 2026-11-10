// Contracts for the "Build Now" items (docs/rivtor_build_now.md): smart routing and wiring,
// streaming, auth and payment auto-wiring, safe migrations, scoped keys and approvals.
// Detection (pure, @rivtor/detect) fills the plan-side shapes; the control plane acts on them.

// ---------------------------------------------------------------- 1. routing and wiring

/** Where a path rule came from, strongest first when they disagree. */
export type PathRuleSource =
  | "toml" // deploy.toml [routes] (an answer the user/agent already gave)
  | "config" // vite server.proxy, package.json "proxy", next rewrites(), vercel.json, _redirects, nginx
  | "routes" // a frontend call matched a route the backend really serves
  | "live"; // learned from the verification browser / production edge

/**
 * A path on a frontend's hostname that is served by another service of the same project.
 * Matching is by path prefix on segment boundaries: "/api" matches "/api" and "/api/x", not "/apix".
 */
export interface PathRule {
  /** Frontend service whose hostname gets the rule. */
  service: string;
  /** Path prefix, starts with "/", no trailing slash (except "/" itself, which is never emitted). */
  prefix: string;
  /** Service that answers these paths. */
  target: string;
  /** Strip `prefix` before forwarding (vite `rewrite: p => p.replace(/^\/api/, "")`). */
  strip?: boolean;
  source: PathRuleSource;
  /** Human-readable evidence, e.g. "web/src/api.ts:12 fetch('/users') ~ api GET /users". */
  evidence?: string;
}

/** A wiring problem detection found, with what Rivtor did about it. */
export interface WiringFix {
  service: string;
  /** Stable code, e.g. "hardcoded_localhost", "django_proxy", "asyncpg_url", "prisma_pgbouncer". */
  code: string;
  /** "applied": Rivtor changed env/command/routing itself. "reported": the agent must edit code. */
  action: "applied" | "reported";
  message: string;
  file?: string; // "web/src/api.ts:12"
  fix?: string; // what to change, for reported fixes
  /**
   * Env vars Rivtor sets for this fix (values are never secrets). Only "applied" fixes carry env.
   * They override data/wired env of the same name for this service; user env (deploy.toml
   * [services.x.env], env_set) overrides them. Values are templates the control plane expands:
   *   {host}                 comma-separated hostnames that reach this service: its own
   *                          <slug>[-<name>].rivtor.app, active custom domains, and the hostnames of
   *                          frontends whose PathRules target it (Django ALLOWED_HOSTS)
   *   {origin}               the same list as https:// origins (Django CSRF_TRUSTED_ORIGINS)
   *   {database_url}         the managed Postgres URL as injected in DATABASE_URL (via PgBouncer)
   *   {direct_database_url}  the direct Postgres URL, as in DIRECT_DATABASE_URL
   *   {database_url:SCHEME}  / {direct_database_url:SCHEME}: the same URL with its scheme replaced,
   *                          e.g. {database_url:postgresql+asyncpg}
   * A "?k=v" right after a URL placeholder is merged into that URL's query string ("&" if it
   * already has one): "{database_url}?pgbouncer=true". Text without braces is literal.
   */
  env?: Record<string, string>;
  /**
   * Replacement start command for this fix (e.g. uvicorn --proxy-headers). Detection already put it
   * in DetectedService.startCommand; it is reported instead when deploy.toml sets the command.
   */
  startCommand?: string;
}

/** Routing data the router/edge needs per frontend service (stored on services.config.routing). */
export interface ServiceRouting {
  /** `source` is kept so rules learned live ("live") survive the next deploy unless replaced. */
  rules: Array<Pick<PathRule, "prefix" | "target" | "strip"> & { source?: PathRuleSource }>;
  /**
   * Layer 2: for paths this frontend does not serve, send data requests
   * (Sec-Fetch-Dest: empty, JSON Accept) to this service.
   */
  dataFallback?: string;
  /** Path prefixes the frontend serves itself (e.g. Next.js app/api routes): never rerouted. */
  ownPrefixes?: string[];
  /** Origins allowed to call this (backend) service cross-origin; CORS headers added at the edge. */
  corsOrigins?: string[];
  /**
   * Frontend services of the same project whose hostnames and custom domains are also allowed
   * (resolved by the router at load time, so custom domains added later work without a redeploy).
   */
  corsServices?: string[];
  /** Streaming routes on this service: buffering/compression off, SSE keep-alive. */
  streamingPrefixes?: string[];
  /** Websocket paths on this service. */
  websocketPrefixes?: string[];
}

// ---------------------------------------------------------------- 2. streaming

export interface StreamingRoute {
  service: string;
  path: string; // "/api/chat"
  kind: "sse" | "stream" | "websocket";
  evidence: string; // file:line
  /** HTTP method when known ("GET", "POST"); verification only calls GET routes. */
  method?: string;
}

/** A handler that calls an LLM API without streaming or a background job (item 2 warning). */
export interface UnstreamedLlmRoute {
  service: string;
  /** Route path when determinable, else null. */
  path: string | null;
  evidence: string; // file:line
}

// ---------------------------------------------------------------- 3 + 4. auth and payments

export type AuthProvider =
  "better-auth" | "authjs" | "clerk" | "supabase-auth" | "fastapi-auth";
export type PaymentProvider = "stripe" | "razorpay";

export interface AuthIntegration {
  service: string;
  provider: AuthProvider;
  /** OAuth providers the code configures: "google", "github", ... */
  oauthProviders: string[];
  /** Env vars Rivtor generates once (random secrets) and stores as source='generated'. */
  generatedSecrets: string[];
  /** Env vars Rivtor sets to the live URL (never localhost). */
  baseUrlVars: string[];
  /** Callback path template per OAuth provider, e.g. { google: "/api/auth/callback/google" }. */
  callbackPaths: Record<string, string>;
  evidence: string;
}

export interface PaymentIntegration {
  service: string;
  provider: PaymentProvider;
  /** Webhook route path in this service, e.g. "/api/webhooks/stripe". */
  webhookPath: string | null;
  /** Events the code handles, e.g. ["checkout.session.completed"]. */
  events: string[];
  /** Env var the code reads for the API secret key (asked once via needs_input). */
  secretKeyVar: string;
  /** Env var Rivtor stores the signing secret in (never shown to the agent). */
  webhookSecretVar: string;
  /** Razorpay: env var the code reads for the key id (rzp_test_/rzp_live_ tells the mode). */
  keyIdVar?: string;
  evidence: string;
}

export interface Integrations {
  auth: AuthIntegration[];
  payments: PaymentIntegration[];
  /** pgvector / vector-store libraries found (item 7). */
  vector: Array<{ service: string; library: string; evidence: string }>;
  streaming: StreamingRoute[];
  /** Item 2: LLM calls without streaming or a background job (warned at plan and verification). */
  unstreamedLlm?: UnstreamedLlmRoute[];
}

// ---------------------------------------------------------------- 5 + 6. migrations and approvals

export type DestructiveKind =
  | "drop_table"
  | "drop_column"
  | "alter_type"
  | "set_not_null"
  | "rename_drop_add"
  | "truncate";

export interface DestructiveChange {
  kind: DestructiveKind;
  table: string;
  column?: string;
  statement: string; // trimmed SQL / ORM op, <= 300 chars
  file: string; // "prisma/migrations/2026_x/migration.sql:4"
  /** Rows in the table now (filled by the control plane; detection leaves it undefined). */
  rows?: number;
  /** Migration tool that owns the file ("sql" = plain SQL, applied state unknown). */
  tool?: MigrationTool;
  /**
   * Id the tool records once the migration ran: Prisma folder name, Alembic revision,
   * Django "app.0003_name", Drizzle sha256 of the file. Lets the control plane skip applied ones.
   */
  migrationId?: string;
  /** Alembic: revisions in the upload that descend from migrationId (applied if the DB head is one of them). */
  laterIds?: string[];
}

export type MigrationTool = "prisma" | "drizzle" | "alembic" | "django" | "sql";

export type TokenScope = "read" | "deploy" | "admin";

export type ApprovalAction =
  "destroy" | "drop_database" | "destructive_migration" | "db_write" | "db_restore";

/** Returned in AgentError.approval when status is needs_approval. */
export interface ApprovalRequest {
  id: string;
  action: ApprovalAction;
  project: string;
  /** One sentence for the agent to relay to the user. */
  summary: string;
  details?: Record<string, unknown>;
  /** Browser link the user opens to approve. */
  url: string;
  expiresAt: string;
}
