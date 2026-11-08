// Generated from the Rivtor monorepo (packages/shared/src/types.ts). Do not edit here.
// Shared contracts between detection, control plane, CLI/MCP and dashboard.
import type { VerificationReport } from "./verify.js";

export type ServiceKind = "static" | "web" | "api" | "worker" | "custom";
export type Runtime = "edge" | "container";
export type Builder = "static" | "railpack" | "dockerfile";
export type DataKind = "postgres" | "redis" | "r2" | "mysql" | "mongodb";
export type Language =
  | "node"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "php"
  | "dotnet"
  | "elixir"
  | "kotlin"
  | "deno"
  | "static"
  | "unknown";

/** One deployable unit found in the repo by the detection engine. */
export interface WorkloadVolume {
  type: "volume" | "bind";
  source: string; // named project volume, or repo-relative read-only source
  target: string;
  readOnly: boolean;
}
export interface WorkloadConfig {
  runOnce?: boolean;
  healthcheck?: {test: string[]; intervalMs?: number; timeoutMs?: number; startPeriodMs?: number; retries?: number};
  image?: string;
  dockerfile?: string;
  command?: string | string[];
  entrypoint?: string | string[];
  protocol?: "http" | "grpc" | "tcp";
  schedule?: string; // five-field UTC cron; kind remains worker for compatibility
  volumes?: WorkloadVolume[];
  dependsOn?: Record<string, "service_started" | "service_healthy" | "service_completed_successfully">;
  composeFile?: string;
  environmentKeys?: string[];
  envBindings?: Record<string, { resource: string; type: "data" | "service"; component: "url" | "host" | "port" | "username" | "password" | "database"; suffix?: string }>;
  buildArgs?: Record<string, string>;
  buildTarget?: string;
}
export interface ManagedDataResource {
  name: string;
  kind: Exclude<DataKind, "r2">;
  image: string;
  database?: string;
  volumes?: WorkloadVolume[];
}
export interface DetectionQuestion {
  service: string;
  field: "startCommand";
  question: string;
  source: string;
}
export interface DetectedService {
  name: string; // derived from folder ("web", "api"); root repo => project slug-ish "app"
  rootDir: string; // relative to repo root, "." for root
  kind: ServiceKind;
  runtime: Runtime;
  builder: Builder;
  language: Language;
  framework: string | null; // "nextjs", "vite", "astro", "fastapi", "express", ...
  packageManager?:
    "pnpm" | "npm" | "yarn" | "bun" | "pip" | "uv" | "poetry" | "go" | null;
  buildCommand: string | null;
  startCommand: string | null; // null for static
  outputDir: string | null; // static output dir relative to rootDir ("dist", "out", "build")
  port: number | null; // container port the app listens on (we also inject PORT)
  healthPath: string; // default "/"
  migrateCommand: string | null;
  dataNeeds: DataKind[];
  /** env var names this service reads (from code + .env.example) */
  envNames: string[];
  /** URL env vars that should point at another service, e.g. { NEXT_PUBLIC_API_URL: "api" } */
  wiring: Record<string, string>;
  public: boolean; // workers are false
  contentHash: string; // sha256 of all files under rootDir (respecting ignores)
  workload?: WorkloadConfig;
}

export interface Assumption {
  service?: string;
  message: string; // "Assumed 'api' listens on port 8000 (uvicorn default)"
  override?: string; // how to change it: `deploy.toml` key or `deploy` arg
}

export interface MissingSecret {
  name: string;
  service: string;
  usedIn: string[]; // ["api/payments.py:3"]
}

/** Output of detect + plan. Returned by `deploy` with dry_run, and stored in deployments.plan. */
export interface DeployPlan {
  managedData?: ManagedDataResource[];
  questions?: DetectionQuestion[];
  services: DetectedService[];
  data: DataKind[];
  env: Array<{
    service: string;
    key: string;
    source: "wired" | "data" | "user";
    valuePreview: string;
  }>;
  missingSecrets: MissingSecret[];
  assumptions: Assumption[];
  warnings: string[];
  /** deploy.toml [verify] settings, carried to the verifier */
  verify?: DeployToml["verify"];
}

/** deploy.toml (optional) — overrides detection. */
export interface DeployToml {
  services?: Record<
    string,
    Partial<
      Pick<
        DetectedService,
        | "rootDir"
        | "kind"
        | "framework"
        | "buildCommand"
        | "startCommand"
        | "outputDir"
        | "port"
        | "healthPath"
        | "migrateCommand"
        | "public"
        | "workload"
      >
    > & {
      data?: DataKind[];
      env?: Record<string, string>;
      builder?: Builder;
    }
  >;
  ignore?: string[];
  /** [verify]: routes excluded from / added to verified-deploy checks, opt-in browser error script */
  verify?: {
    exclude?: string[];
    routes?: string[];
    enabled?: boolean;
    browserErrors?: boolean;
  };
}

export type DeployStage =
  | "upload"
  | "detect"
  | "plan"
  | "provision"
  | "build"
  | "migrate"
  | "release"
  | "return";

/** Every failure returned to agents uses this shape (architecture doc: "Errors written for agents"). */
export interface AgentError {
  status: "failed" | "needs_input";
  stage: DeployStage | "auth" | "limits" | "env" | "domain" | "db" | "rollback";
  service?: string;
  code: string; // stable machine code from the known-error library, e.g. "missing_python_module"
  cause: string;
  file?: string; // "api/payments.py:3"
  fix: string;
  retryable: boolean;
  missing?: MissingSecret[]; // for needs_input
  upgrade?: UpgradeHint; // when the fix is a plan upgrade
  logTail?: string[]; // last relevant log lines for unknown errors
  docs?: string;
}

export interface UpgradeHint {
  trigger: string;
  message: string; // one short sentence, shown once per session
  plan: "hobby" | "pro" | "team";
  url: string; // payment link
}

export interface ServiceStatus {
  name: string;
  kind: ServiceKind;
  runtime: Runtime;
  status:
    | "pending"
    | "building"
    | "deploying"
    | "live"
    | "sleeping"
    | "failed"
    | "stopped";
  url: string | null;
  framework: string | null;
  releaseId: string | null;
  updatedAt: string;
}

export interface DataServiceStatus {
  kind: DataKind;
  status: string;
  sizeBytes: number;
  limitBytes: number;
}

export interface DeployResult {
  status: "live" | "failed" | "needs_input";
  deploymentId: string;
  project: string;
  urls: Record<string, string>; // service name -> URL
  services: ServiceStatus[];
  data: DataServiceStatus[];
  databaseUrl?: string; // masked unless explicitly requested
  dashboardUrl: string;
  durationMs: number;
  plan?: DeployPlan;
  error?: AgentError;
  upgrade?: UpgradeHint;
  notes?: string[];
  verification?: VerificationReport;
  verificationSkipped?: boolean;
  /**
   * How the changed services went live: `hot` = code-only change applied as a thin layer on the
   * current image (full build follows in the background), `full` = normal build.
   */
  swapMode?: "hot" | "full";
  hotSwap?: HotSwapInfo;
}

/** Details of a hot swap (DeployResult.swapMode = "hot"). */
export interface HotSwapInfo {
  services: Array<{ name: string; releaseId: string; files: number; deleted: number }>;
  /** ms from deploy start until the hot-swapped release was live */
  liveMs: number;
  /** background full build: running -> succeeded (container replaced by the real image) | failed */
  background: "running" | "succeeded" | "failed";
  backgroundError?: string;
}

export type * from "./verify.js";
