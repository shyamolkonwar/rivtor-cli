# Rivtor result shapes

## Contents

- [DeployResult](#deployresult)
- [AgentError](#agenterror)
- [VerificationReport](#verificationreport)
- [ProjectIssue](#projectissue)
- [Other responses](#other-responses)

## DeployResult

Returned by `deploy` (and `rollback`).

| Field | Meaning |
| --- | --- |
| `status` | `live`, `failed` or `needs_input`. |
| `deploymentId` | Pass to `logs` as `deployment_id` for the build log. |
| `project` | Project slug. |
| `urls` | Service name → public URL. |
| `services[]` | `name`, `kind` (`static`/`web`/`api`/`worker`/`custom`), `runtime` (`edge`/`container`), `status` (`pending`, `building`, `deploying`, `live`, `sleeping`, `failed`, `stopped`), `url`, `framework`, `releaseId`. |
| `data[]` | `kind` (`postgres`, `redis`, `r2`, ...), `status`, `sizeBytes`, `limitBytes`. |
| `databaseUrl` | Masked unless explicitly requested. |
| `dashboardUrl` | Project page on rivtor.com. |
| `durationMs` | Deploy time. |
| `plan` | The `DeployPlan` used (see below). |
| `error` | `AgentError` when `status` is `failed` or `needs_input`. |
| `verification` | `VerificationReport`, also present on a blocked (failed) deploy. |
| `verificationSkipped` | `true` when verification was turned off. |
| `upgrade` | Optional `{trigger, message, plan, url}` note. Mention once. |
| `notes[]` | Extra information for the user. |
| `swapMode`, `hotSwap` | `hot`: a code-only change went live as a thin layer while a full build runs in the background (`hotSwap.background`: `running`, `succeeded`, `failed` with `backgroundError`). `full`: normal build. |

### DeployPlan (`dry_run` result and `DeployResult.plan`)

| Field | Meaning |
| --- | --- |
| `services[]` | Detected services: `name`, `rootDir`, `kind`, `builder`, `language`, `framework`, `buildCommand`, `startCommand`, `outputDir`, `port`, `healthPath`, `migrateCommand`, `dataNeeds`, `envNames`, `wiring`, `public`. |
| `data` | Data services to provision. |
| `env[]` | `{service, key, source: wired/data/user, valuePreview}`. |
| `missingSecrets[]` | `{name, service, usedIn: ["api/payments.py:3"]}`. Ask the user for these. |
| `assumptions[]` | `{service, message, override}`: what detection assumed and the `deploy.toml` key that changes it. |
| `warnings[]` | Read and act on these before deploying. |
| `questions[]` | Detection questions (for example an unknown start command). |

## AgentError

Every failure uses this shape, on its own (tool error) or as `DeployResult.error`.

| Field | Meaning |
| --- | --- |
| `status` | `failed`, `needs_input` or `needs_approval`. |
| `stage` | `upload`, `detect`, `plan`, `provision`, `build`, `migrate`, `release`, `return`, or `auth`, `limits`, `env`, `domain`, `db`, `rollback`. |
| `service` | The failing service, when known. |
| `code` | Stable machine code. See [errors.md](errors.md). |
| `cause` | What went wrong, in one sentence. |
| `file` | Source location when known, e.g. `api/main.py:12`. |
| `fix` | The concrete change to make. Build/runtime fixes end with "then call deploy again". |
| `retryable` | `false`: the same call fails again unless something changes. |
| `missing[]` | For `needs_input`: `{name, service, usedIn}`. |
| `approval` | For `needs_approval`: `{id, action, project, summary, url, expiresAt}`. |
| `upgrade` | When the fix is a plan upgrade: `{trigger, message, plan, url}`. |
| `logTail[]` | Last relevant log lines, for `unknown` errors. |
| `docs` | Link to the error's docs entry. |

## VerificationReport

Returned by `verify` and as `DeployResult.verification`.

| Field | Meaning |
| --- | --- |
| `verdict` | `working`, `partly_working` or `broken`. |
| `summary` | One-line summary. |
| `issues[]` | See below. |
| `checks` | `{passed, warnings, failed}` counts. |
| `groups[]` | `{group, ran, reason, passed, failed, warnings}` for `reachability`, `pages`, `api`, `data`, `config`, `security`. `ran: false` with a `reason` means skipped, not passed. |
| `pages[]` | `{service, path, status, ms, ok, consoleErrors, failedRequests}`. |
| `report_url` | Private report page (requires sign-in and project access). |
| `mode` | `candidate` (checked before traffic switched) or `live` (public URLs). |
| `trigger` | `deploy`, `manual`, `scheduled`, `env_change`, `migration`, `fix`, `journey`. |
| `blocked` | `true`: the candidate was not promoted; the previous release keeps serving. |

Verdict rules: any blocking issue, or a critical issue in `reachability`, `api` or `data`, makes the
verdict `broken`. Any other warning or critical issue makes it `partly_working`. A critical
`security` issue (for example an exposed secret) always blocks promotion.

### VerifyIssue (`issues[]`)

| Field | Meaning |
| --- | --- |
| `severity` | `critical`, `warning` or `info`. |
| `check` | Check group (`reachability`, `pages`, `api`, `data`, `config`, `security`, `journey`). |
| `code` | Stable code, e.g. `page_failed`, `cors_blocked`, `client_secret`. See [errors.md](errors.md#verification-issue-codes). |
| `where` | Route, env var or location, e.g. `GET /dashboard → 500`, `NEXTAUTH_URL`. |
| `cause`, `file`, `fix` | What, where in the source, and what to change. |
| `blocking` | `true`: this issue alone makes the verdict `broken`. |
| `auto_fixable` | A server-side `verify_fix` exists. It still needs the user's consent. |
| `fix_action` | Machine-readable fix: `set_env_url` (service, key, value), `cors_origin` (service, origin) or `security_headers` (service). |
| `issue_id` | Persistent issue id for `issue_resolve` / `verify_fix`. |

## ProjectIssue

Returned by `issues`.

| Field | Meaning |
| --- | --- |
| `id` | UUID for `issue_resolve` and `verify_fix`. |
| `source` | `verify`, `production`, `security` or `browser`. |
| `severity`, `status` | `critical`/`warning`/`info`; `open`/`resolved`/`dismissed`. |
| `check`, `service`, `where`, `cause`, `file`, `fix` | As in `VerifyIssue`. |
| `release` | Release the issue was seen on. |
| `count`, `firstSeen`, `lastSeen` | Recurrence. |
| `stack[]`, `request` | Production error stack and request (`method`, `path`, `status`, `ms`). |
| `rollbackHint` | Rollback suggestion, when available. |

Production re-check interval by plan: Free none, Hobby daily, Pro every 15 minutes, Team every
5 minutes. Error retention: Hobby 7 days, Pro 30, Team 90.

## Other responses

- `deploy` with `dry_run`: local `{status: "dry_run", project, plan, files, bytes}`; remote
  `{dry_run: true, project, created, plan, dashboardUrl}`.
- Remote `deploy` with `wait: false`: `{status: "queued", project, deploymentId, next}`.
- Remote `deploy` after 15 minutes: `{status: "in_progress", project, deploymentId, fix}`.
- `destroy` first call (API key): an AgentError with status `needs_approval` and `approval`
  `{id, action, project, summary, url, expiresAt}`. Call with `approval_token`: deletion result.
- `untrusted: true` and `untrustedNote` lead results that carry application output (logs,
  verification and issue text, deploy `logTail`); the rest of the shape is unchanged.
- `env_set`: key names set/removed and whether services restarted. Never the values.
