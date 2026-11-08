---
name: rivtor
description: >-
  Deploys and operates apps on Rivtor, which ships frontend, backend, Postgres, Redis and object
  storage in one call through the Rivtor MCP tools or the rivtor CLI, and reads verified-deploy
  results to diagnose and fix failures. Use when the user wants to deploy, host or put an app live,
  fix a failed or broken Rivtor deploy, check status or logs, set env vars or secrets, query the
  project database, add a custom domain, roll back, or handle production issues on Rivtor.
license: MIT
---

# Rivtor

Rivtor deploys a whole repo (web, API, workers, Postgres, Redis, R2 storage) with one `deploy`
call, verifies the candidate before traffic moves, and returns a structured result written for
agents. Work in a loop: deploy, read the result, fix, deploy again.

## Connect

Use the first option that is already available. Check for Rivtor tools (`deploy`, `status`,
`logs`, `env_set`, ...) before suggesting setup.

| Option | Setup the user runs | Use when |
| --- | --- | --- |
| Local MCP (stdio) | `claude mcp add rivtor -- npx -y rivtor mcp` after `npx rivtor login` | The code is a folder on disk (most coding agents). Its `deploy` uploads the folder. |
| Remote MCP (HTTP) | `claude mcp add --transport http rivtor https://api.rivtor.com/mcp`, then `/mcp` → `rivtor` → Authenticate | No local Node, or deploying from a git URL, starter or inline files. |
| CLI | `npx rivtor login`, then `npx rivtor deploy --json` | No MCP client, CI, or a quick shell call. |

Authentication rules:

- Remote MCP signs in with OAuth: the user pastes `https://api.rivtor.com/mcp` into the client and
  clicks Allow on rivtor.com. Clients without OAuth send `Authorization: Bearer rvt_...`.
- A token is 44 characters: `rvt_` plus 40. The 12-character prefix shown in the token list is not
  a token (`token_prefix_only`). Tokens are shown once at https://rivtor.com/dashboard/tokens.
- Ask the user to run `npx rivtor login` in their own terminal (input is hidden). Do not ask them
  to paste a token into the chat, and never write a token into a file in the repo.
- Other clients (Cursor, Codex, Claude Desktop): see [references/tools.md](references/tools.md#connect).

## Interface differences

Remote and local MCP servers expose the same tool names with a few different arguments. Check
which server is connected before calling:

| Tool | Remote (`api.rivtor.com/mcp`) | Local (`npx -y rivtor mcp`) |
| --- | --- | --- |
| `deploy` source | `project` (required) + one of `git_url` (+`ref`), `starter`, `files` | `path` (folder), optional `project` |
| `env_set` values | `set: {KEY: value}` | `vars: {KEY: value}` |
| `db` actions | `query`, `tables`, `connection`, `export_url` | `query`, `connection`, `export` (+`output`) |

Never inline a local folder into remote `files` (2 MB cap); use the local server or
`npx -y rivtor deploy <path>` instead. Full arguments and CLI flags:
[references/tools.md](references/tools.md).

## Core loop

1. **Plan (first deploy or after big changes).** Call `deploy` with `dry_run: true` (CLI:
   `--dry-run`). Check `plan.services`, `plan.data`, `plan.missingSecrets`, `plan.assumptions` and
   `plan.warnings`. Fix wrong detection with `deploy.toml`, not by guessing
   ([references/config.md](references/config.md)).
2. **Deploy.** Call `deploy` (CLI: `npx rivtor deploy --json`). It waits for the result.
3. **Branch on `status`:**
   - `live`: read `verification.verdict`.
     - `working`: report `urls` and the `verification.report_url`.
     - `partly_working`: the release is live with issues. Report `urls`, list each issue's
       `cause` and `fix`, then fix what is in the code.
     - No `verification` and `verificationSkipped: true`: say the deploy is live but unverified.
   - `needs_input`: read `error.missing` (or `plan.missingSecrets`). Ask the user once for every
     missing value, store them with `env_set`, then deploy again.
   - `failed`: read `error.code`, `error.stage`, `error.service`, `error.cause`, `error.file` and
     `error.fix`. Apply the fix in the code, then deploy again. Only changed services rebuild.
     - `error.code: "verification_failed"`: the candidate was blocked and the previous release is
       still serving (`urls` is empty; get the serving URLs from `status`). Fix
       `verification.issues` (blocking ones first), then deploy again.
     - `error.code: "unknown"`: read `error.logTail`, then `logs` with `deployment_id`.
   - `in_progress` / `queued` / `started`: poll `status` (or `logs` with `deployment_id`).
4. **Redeploy the fixed code** the same way it was deployed. If only the remote server is
   connected and the code is a local folder, redeploy with `npx -y rivtor deploy <path> --json`
   (or connect the local server); never inline the folder into remote `files`.
5. **Upgrade notes.** When a result carries `upgrade`, mention it once, briefly. It never blocks.

`env_set` restarts services without a rebuild, so runtime variables apply at once. Build-time
variables (`NEXT_PUBLIC_*`, `VITE_*`) are baked into the bundle: deploy again after changing them.

Field meanings and shapes: [references/results.md](references/results.md). CLI exit codes:
`deploy` exits `0` live, `1` failed, `2` needs input; `verify` exits `0` only for `working`.

## Stop conditions

- Cap retries: at most 3 deploys for the same `error.code`, and 5 fix-and-redeploy rounds per
  task. If the same code and cause come back after a fix, stop and explain what was tried.
- `retryable: false` means redeploying unchanged code fails the same way. Change something first.
- Retry once without changes only for transient codes: `registry_network_error`,
  `provision_failed`, `interrupted`, `engine_unavailable`, `rate_limited` (wait first).
- Stop and hand over to the user when the fix needs a human:
  - secret values (`needs_input`, `missing_env`), payment (`upgrade`, any `*_limit` code),
  - DNS records after `domain_add`, account checks (`verification_required`),
  - suspensions (`blocked_by_abuse_scan`, `project_suspended`, `account_suspended`),
  - sign-in problems (`not_logged_in`, `unauthorized`, `token_prefix_only`, `token_expired`),
  - consent steps (`destroy` confirmation, `verify_fix`, `import` approvals).

## Diagnose

Start from the structured error; open logs only when it is not enough.

| Signal | Action |
| --- | --- |
| `missing_node_module`, `missing_python_module`, `command_not_found` | Add the package to the manifest (runtime deps in `dependencies`, not `devDependencies`), commit the lockfile, deploy. |
| `bound_to_localhost`, `wrong_port`, `health_check_timeout`, `permission_denied` on a low port | Listen on `0.0.0.0` and the `PORT` env var, e.g. `uvicorn main:app --host 0.0.0.0 --port $PORT`. Or set `port` in `deploy.toml`. |
| `missing_env_var`, `missing_env_at_build`, `missing_secrets` (status `needs_input`) | Ask the user for the values, `env_set`, deploy again. |
| `data_service_not_provisioned`, `db_connection_refused`, `redis_connection_refused` | Read `DATABASE_URL` / `REDIS_URL` from env; add `data = ["postgres"]` (or `"redis"`) to the service in `deploy.toml` if detection missed it. |
| `db_schema_missing`, `*_migration_failed`, `migration_pending` | Add or fix the migration and `migrateCommand`; a failed migration never replaces the serving release. |
| `out_of_memory` | Reduce memory (workers, `NODE_OPTIONS=--max-old-space-size`), else surface the upgrade hint and let the user decide. |
| `client_secret` / `source_secret` | `where` names the leaking file or bundle. Search the source for the variables it inlines (`NEXT_PUBLIC_*`, `VITE_*`, hard-coded keys), move the secret to server-side env, tell the user to rotate it, deploy again. Never print the value. |
| `page_failed`, `api_failed`, `cors_blocked`, `wrong_live_url`, `localhost_config` | Read the issue's `where`, `file` and `fix`; fix the route or env; deploy or `verify`. |

Every code with its fix, grouped by area: [references/errors.md](references/errors.md).

Investigation tools:

- `logs` with `deployment_id`: the build/deploy log of one deployment.
- `logs` with `service`, `since` (`15m`, `2h`), `level: "error"`: runtime logs, summarised.
- `status`: services, URLs, data usage, last deployment, last verdict and open issue count.
- `verify`: re-check the live app without redeploying.
- `issues` (`status: "open"`): persistent verification, security and production issues.
- `rollback`: restore the previous release in seconds when production is broken and the fix is
  not quick. It does not rebuild.

## Verification and production watch

- Verdicts: `working`, `partly_working`, `broken`. A `broken` candidate is blocked
  (`verification.blocked: true`) and the previous release keeps serving.
- Skipped check groups (`verification.groups[].ran: false`) are not passes. Mention them.
- `verify: false` (CLI `--no-verify`) skips functional checks only; the secret scan still blocks.
  Never use it to push a broken release live.
- Production watch (paid plans) records issues; read them with `issues`, fix, deploy, `verify`,
  then mark them with `issue_resolve` (`resolved`, or `dismissed` only for a confirmed false
  positive).
- `verify_fix` applies only server-allowlisted config fixes (env URL, CORS origin, security
  headers) and requires `consent: true`. Ask the user first.
- `verify_sleeping`: a Free-plan app is asleep. Request its URL to wake it, then `verify`.

## Safety rules

- Never print secret values, tokens or connection strings. Tool results mask them; keep it that
  way in your replies. Give `db` `connection` output to the user only when they ask for it.
- Never commit `.env` files or put secrets in `deploy.toml` or source. `.env` files are never
  uploaded; send values with `env_set`, `deploy` `env`, or CLI `--env-file`.
- Do not override Rivtor-managed variables (`DATABASE_URL`, `REDIS_URL`, `S3_*`); they are
  read-only (`env_read_only`).
- `destroy` deletes the project and all its data. Call it without `confirm_token`, show the user
  what will be deleted, and call again with the token only after their explicit yes. Never
  confirm on the user's behalf.
- `upgrade` returns a payment link. Call it only when the user asks to upgrade; the user pays.
- `domain_add` returns DNS records the user must create. Do not report the domain as working
  until DNS resolves and HTTPS is issued.
- `import`, `import_cutover` and `import_undo` need fresh, explicit user approval for each step.

## References

- [references/tools.md](references/tools.md): every MCP tool and CLI command with exact
  arguments, plus client setup.
- [references/results.md](references/results.md): `DeployResult`, `AgentError`,
  `VerificationReport` and project issue fields.
- [references/errors.md](references/errors.md): every error and verification code with its fix.
- [references/config.md](references/config.md): `deploy.toml`, detection, data env vars, plan
  limits, sleep and wake.
- [references/examples.md](references/examples.md): worked transcripts (first deploy, failed
  build, missing secret, production issue).
