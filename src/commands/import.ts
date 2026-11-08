import type { Command } from "commander";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, relative } from "node:path";
import { action, CliError, getClient, printJson, projectSlug } from "../context.js";
import { ask, askSecret } from "../prompt.js";
import { manifestDir, packBlobs } from "../pack.js";
import type { ApiClient } from "../api.js";
const CONFIG_FILES = ["vercel.json", "render.yaml", "render.yml", "railway.json", "railway.toml", "Procfile", "app.json", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
interface ImportView {
  id: string; state: string; revision: number; planDigest: string;
  plan?: { source: string; services: Array<{ name: string; kind: string }>; env: Array<{ service: string; name: string; available: boolean }>; domains: string[]; resources: Array<{ name: string; kind: string; supported: boolean }>; decisions: Array<{ resource: string; reason: string; replacement: string; blocking: boolean }> };
  error?: { cause: string; fix: string }; undoUntil?: string;
  operation?: { id: string } | null;
}
export async function readImportConfigs(directory: string): Promise<Record<string, string>> {
  const root = await realpath(resolve(directory)); const files: Record<string, string> = {}; let total = 0;
  for (const name of CONFIG_FILES) {
    const path = join(root, name); const stat = await lstat(path).catch(e => { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new CliError("Provider config symlinks are not followed. Supply regular config files inside the repository.");
    if (!stat.isFile() || stat.size > 512000) throw new CliError("Provider config must be a regular file no larger than 512 KB.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const raw = await file.readFile("utf8"); total += Buffer.byteLength(raw); if (total > 1_000_000) throw new CliError("Provider config bundle exceeds 1 MB."); files[name] = raw; }
    finally { await file.close(); }
  }
  return files;
}
const basePath = (slug: string) => `/v1/projects/${encodeURIComponent(slug)}/imports`;
const idPath = (slug: string, id: string) => `${basePath(slug)}/${encodeURIComponent(id)}`;
/** Read only the exact user-selected request file, never a conventional credentials path. */
export async function readImportInput(path: string): Promise<Record<string, unknown>> {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > 3 * 1024 * 1024) throw new CliError("Import input must be a regular JSON file below 3 MB.");
    try { const value = JSON.parse(await file.readFile("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
    catch { throw new CliError("Invalid import JSON input; its content is withheld to protect credentials."); }
  } finally { await file.close(); }
}
interface RequestClient { request(method: string, path: string, opts?: { json?: unknown; signal?: AbortSignal }): Promise<unknown> }
export async function waitForImportOperation(client: RequestClient, slug: string, initial: ImportView, options: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<ImportView> {
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let record = initial;
  while (record.operation) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CliError(`Import ${initial.id} is still running. Read its status; do not replay the pending action.`);
    await sleep(Math.min(1000, remaining));
    const budget = deadline - Date.now();
    if (budget <= 0) throw new CliError(`Import ${initial.id} is still running. Read its status; do not replay the pending action.`);
    record = await client.request("GET", idPath(slug, initial.id), { signal: AbortSignal.timeout(budget) }) as ImportView;
    if (record.id !== initial.id) throw new CliError("Import status identity did not match the requested job.");
  }
  return record;
}
export async function importActionRequest(client: RequestClient, slug: string, id: string, actionName: string, record: { revision: number; planDigest: string }, acknowledgeDnsOnlyUndo = false): Promise<ImportView> {
  return await client.request("POST", `${idPath(slug, id)}/${actionName}`, { json: { expectedRevision: record.revision, planDigest: record.planDigest, approve: true, ...(actionName === "undo" ? { acknowledgeDnsOnlyUndo } : {}) }, signal: AbortSignal.timeout(20 * 60_000) }) as ImportView;
}
function printImport(record: ImportView, json?: boolean): void {
  if (json) { printJson(record); return; }
  process.stdout.write(`Import ${record.id}: ${record.state}\n`);
  if (record.plan) {
    for (const s of record.plan.services) process.stdout.write(`  Service: ${s.name} (${s.kind})\n`);
    for (const r of record.plan.resources) process.stdout.write(`  Data: ${r.name} (${r.kind})${r.supported ? "" : " — NOT automatically imported"}\n`);
    for (const e of record.plan.env) process.stdout.write(`  Env: ${e.service}.${e.name}${e.available ? " [encrypted]" : " [value required]"}\n`);
    for (const d of record.plan.decisions) process.stdout.write(`  ${d.blocking ? "Decision required" : "Note"}: ${d.resource}: ${d.reason}\n    ${d.replacement}\n`);
  }
  if (record.error) process.stdout.write(`  ${record.error.cause}\n  ${record.error.fix}\n`);
  if (record.undoUntil) process.stdout.write(`  DNS-only undo expires: ${record.undoUntil}\n`);
  process.stdout.write("  Source host is never deleted. DNS cutover requires separate owner approval.\n");
}
export async function uploadImportSource(client: ApiClient, directory: string, slug: string, privateInputPath?: string): Promise<string> {
  const privatePath = privateInputPath ? relative(resolve(directory), resolve(privateInputPath)).split("\\").join("/") : undefined;
  const extraIgnores = [...CONFIG_FILES, ...(privatePath && !privatePath.startsWith("../") ? [privatePath] : [])];
  const { manifest } = await manifestDir(directory, { extraIgnores });
  if (privatePath && manifest.files.some(f => f.path === privatePath)) throw new CliError("Private import input must never be included in uploaded application source.");
  if (manifest.symlinks?.length) throw new CliError("Import source uploads require regular files; resolve repository symlinks before uploading.");
  const uploaded = await client.uploadManifest(slug, manifest); const id = uploaded.manifestId;
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id) || !Array.isArray(uploaded.missing)) throw new CliError("The source upload returned an invalid manifest response.");
  const missing = uploaded.missing as string[];
  if (missing.length) {
    const pack = await packBlobs(directory, manifest, missing);
    try { const form = new FormData(); form.set("blobs", await pack.blob(), "blobs.tar.gz"); await client.request("POST", `/v1/projects/${encodeURIComponent(slug)}/uploads/blobs`, { query: { manifest: id }, form, stage: "upload" }); }
    finally { await pack.cleanup(); }
  }
  return id;
}
interface Options { project?: string; source?: string; input?: string; providerProject?: string; providerTokenEnv?: string; teamId?: string; environmentId?: string; serviceIds?: string; envGroupIds?: string; tokenKind?: string; manifest?: string; uploadSource?: boolean; json?: boolean; yes?: boolean; execute?: boolean; acknowledgeDnsOnlyUndo?: boolean }
export function registerImport(program: Command): void {
  const command = program.command("import").description("Plan an encrypted source-provider import; old hosts remain intact")
    .argument("[path]", "repository containing provider configs", ".")
    .option("-p, --project <slug>", "existing destination project")
    .option("--source <source>", "vercel, render, railway, heroku, compose or auto", "auto")
    .option("--provider-project <id>", "explicit source project/app/service ID")
    .option("--provider-token-env <name>", "read the source token only from this explicitly named env var")
    .option("--team-id <id>", "Vercel team ID")
    .option("--environment-id <id>", "Railway environment ID")
    .option("--service-ids <ids>", "comma-separated explicit source service IDs")
    .option("--env-group-ids <ids>", "comma-separated explicit Render env group IDs")
    .option("--token-kind <kind>", "Railway account or project token", "account")
    .option("--manifest <id>", "already uploaded immutable source manifest")
    .option("--input <file>", "explicit private JSON request file for data/DNS/secret/retention mappings")
    .option("--upload-source", "upload source files (not provider configs/.env) for the approved deploy")
    .option("--execute", "approve and execute plan/deploy/copy/sync; never cuts over DNS")
    .option("-y, --yes", "approve the requested --execute actions without prompting")
    .option("--json", "print the final names-only JSON response")
    .action(action(async (directory: string, opts: Options) => {
      if (!["vercel", "render", "railway", "heroku", "compose", "auto"].includes(opts.source ?? "auto")) throw new CliError("Unsupported import source.");
      const client = await getClient(); const slug = await projectSlug(opts.project);
      if (!client.loggedIn) await client.me();
      if (!client.apiUrl.startsWith("https://")) throw new CliError("Import credentials require an HTTPS Rivtor API endpoint.");
      const files = await readImportConfigs(directory);
      const supplied = opts.input ? await readImportInput(opts.input) : {};
      let token: string | undefined;
      if (opts.providerProject) {
        if (opts.providerTokenEnv) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.providerTokenEnv)) throw new CliError("Invalid token environment variable name.");
          token = process.env[opts.providerTokenEnv];
        } else if (process.stdin.isTTY && !opts.json) token = await askSecret("Source provider token (read permission; never printed): ");
        if (!token) throw new CliError("Supply a source token through --provider-token-env or the interactive hidden prompt.");
      } else if (opts.providerTokenEnv) throw new CliError("--provider-token-env requires --provider-project.");
      const manifest = opts.manifest ?? (opts.uploadSource ? await uploadImportSource(client, directory, slug, opts.input) : undefined);
      let record = await client.request<ImportView>("POST", basePath(slug), { json: { source: opts.source, files, ...supplied, ...(opts.providerProject ? { provider: { project: opts.providerProject, token, permission: true, teamId: opts.teamId, environmentId: opts.environmentId, serviceIds: opts.serviceIds?.split(","), envGroupIds: opts.envGroupIds?.split(","), tokenKind: opts.tokenKind } } : {}), ...(manifest ? { deploySource: { kind: "manifest", manifestId: manifest } } : {}) }, signal: AbortSignal.timeout(120_000) });
      token = undefined;
      if (!opts.execute) { printImport(record, opts.json); return; }
      if ((opts.json || !process.stdin.isTTY) && !opts.yes) throw new CliError("Non-interactive --execute requires --yes; the plan was saved but no deployment was approved.");
      if (!opts.json) printImport(record);
      for (const step of ["approve", "deploy", "copy", "sync"]) {
        if (!opts.yes && !/^y(?:es)?$/i.test(await ask(`Approve import ${step}? [y/N] `))) break;
        record = await importActionRequest(client, slug, record.id, step, record);
        record = await waitForImportOperation(client, slug, record);
        if (step === "sync") for (let poll = 0; record.state === "syncing" && poll < 120; poll++) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          record = await importActionRequest(client, slug, record.id, "sync", record);
          record = await waitForImportOperation(client, slug, record);
        }
        if (record.state === "blocked") break;
      }
      printImport(record, opts.json);
      if (record.state === "blocked") return 1;
    }));
  command.command("status <id>").description("Read the durable names-only import state").option("-p, --project <slug>").option("--json").action(action(async (id: string, opts: Options) => { const client = await getClient(); printImport(await client.request("GET", idPath(await projectSlug(opts.project), id)), opts.json); }));
  for (const step of ["approve", "deploy", "copy", "sync", "cutover", "undo"]) {
    command.command(`${step} <id>`).description(step === "undo" ? "Restore DNS only within seven days; does not reverse data writes" : `Approve and run import ${step}`)
      .option("-p, --project <slug>").option("--json").option("-y, --yes", "approve this action")
      .option("--acknowledge-dns-only-undo", "acknowledge that new database writes are not copied back")
      .action(action(async (id: string, opts: Options) => {
        const client = await getClient(); const slug = await projectSlug(opts.project); const record = await client.request<ImportView>("GET", idPath(slug, id));
        if (!opts.yes) {
          if (!process.stdin.isTTY || opts.json) throw new CliError("This action requires explicit --yes approval in JSON/non-interactive mode.");
          printImport(record);
          if (!/^y(?:es)?$/i.test(await ask(`Approve ${step}${step === "undo" ? " (DNS only; reconcile new writes separately)" : ""}? [y/N] `))) return;
        }
        if (step === "undo" && !opts.acknowledgeDnsOnlyUndo) throw new CliError("Undo needs --acknowledge-dns-only-undo; it does not reverse data writes made on Rivtor.");
        const started = await importActionRequest(client, slug, id, step, record, opts.acknowledgeDnsOnlyUndo);
        const result = await waitForImportOperation(client, slug, started);
        printImport(result, opts.json); if (result.state === "blocked") return 1;
      }));
  }
}
