# Rivtor tools and CLI reference

## Contents

- [Connect](#connect)
- [MCP tools](#mcp-tools)
- [CLI commands](#cli-commands)
- [Project resolution](#project-resolution)

## Connect

Remote server URL: `https://api.rivtor.com/mcp` (Streamable HTTP, OAuth 2.1 sign-in or
`Authorization: Bearer rvt_...`). Local server: `npx -y rivtor mcp` (stdio, Node.js 20+).

The local server reads the token from `RIVTOR_TOKEN`, else from `~/.config/rivtor/config.json`
written by `npx rivtor login`. `RIVTOR_API_URL` overrides the API endpoint.

| Client | Setup |
| --- | --- |
| Claude Code, sign-in | `claude mcp add --transport http rivtor https://api.rivtor.com/mcp`, then `/mcp` → `rivtor` → Authenticate |
| Claude Code, token | `claude mcp add --transport http rivtor https://api.rivtor.com/mcp --header "Authorization: Bearer rvt_..."` |
| Claude Code, local | `claude mcp add rivtor -- npx -y rivtor mcp` (after `npx rivtor login`) |
| Claude Desktop, claude.ai, ChatGPT | Settings → Connectors → add a custom connector with the URL, sign in, click Allow |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` (below) |
| Codex | `~/.codex/config.toml` (below) |

```json
{
  "mcpServers": {
    "rivtor": {
      "url": "https://api.rivtor.com/mcp",
      "headers": { "Authorization": "Bearer rvt_..." }
    }
  }
}
```

```toml
[mcp_servers.rivtor]
command = "npx"
args = ["-y", "rivtor", "mcp"]
env = { RIVTOR_TOKEN = "rvt_..." }
```

Do not commit a config file that contains a token.

## MCP tools

Every tool returns JSON text. Failures return an `AgentError` with `isError: true`.
`project` is a slug: lowercase letters, digits and dashes. On the local server it is optional
(see [Project resolution](#project-resolution)); on the remote server it is required except for
`upgrade` and `list_projects`.

### deploy

Detect, build, provision data, wire env, verify and release. Returns a `DeployResult`.

| Argument | Server | Meaning |
| --- | --- | --- |
| `path` | local | Folder to deploy (absolute, or relative to the server's working directory). Respects `.gitignore` and `.rivtorignore`; `.env` files are never uploaded; only changed files upload. |
| `project` | both | Project slug. Created if new. |
| `git_url`, `ref` | remote | Public https git repo and optional branch/tag/commit. |
| `starter` | remote | Starter template name, e.g. `nextjs-fastapi-postgres`. |
| `files` | remote | `{relative/path: content}`, max 2 MB total. For agents without a filesystem only. |
| `dry_run` | both | Return the plan only; nothing is built. |
| `env` | both | `{KEY: value}` set before building. Values are never echoed. |
| `clean` | both | Rebuild without build and dependency caches. |
| `verify` | both | Default true. `false` skips functional checks; the secret scan always runs. |
| `wait` | remote | Default true. `false` returns `{status: "queued", deploymentId}`. |

Remote `deploy` takes exactly one source: `git_url`, `starter` or `files`. It waits up to
15 minutes, then returns `{status: "in_progress", deploymentId}`.

### status

`{project}`. Services (status, URL, framework, release), data services (size vs limit), custom
domains, last deployment and the last verification summary. May include an `upgrade` note.

### logs

| Argument | Meaning |
| --- | --- |
| `deployment_id` | Build/deploy log of that deployment instead of runtime logs. |
| `kind` | `audit`: the project's audit log (tool calls and changes with the key and agent; owner only). |
| `service` | One service, e.g. `api`. |
| `since` | `15m`, `1h`, `2d` or an ISO timestamp. |
| `level` | `error`, `warn`, `info` (local also accepts `debug`). |
| `limit` | Max lines (remote 1 to 2000, default 200; local 1 to 1000). |
| `summary` | Default true: repeats collapsed, errors kept. `false` returns raw lines. |

### env_set

Set and/or remove variables; services restart without a rebuild. Values are encrypted and
never returned.

| Argument | Server | Meaning |
| --- | --- | --- |
| `set` | remote | `{KEY: value}` to set. |
| `vars` | local | `{KEY: value}` to set. |
| `remove` | both | Keys to delete. |
| `service` | both | Limit to one service; default all services. |

Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`. Rivtor-managed data variables are read-only.

### rollback

`{project, release_id?}`. Points traffic back at the previous release (or `release_id`) without
rebuilding. Only the last 5 releases can be restored.

### db

Read-only. `{project, action, sql?}`.

| Action | Server | Result |
| --- | --- | --- |
| `query` + `sql` | both | Read-only SQL, 5 s timeout, max 500 rows. |
| `tables` | both | Tables with row counts and sizes. |
| `export_url` | remote | 15-minute download link for a `pg_dump` (custom format). |

### db_connection

`{project}`. Creates a temporary connection string valid 1 hour. A credential: give it to the user
only if asked.

### db_export (local)

`{project, output?}`. Downloads a `pg_dump` to `output` on this machine (overwrites an existing
file).

### domain_add

`{project, hostname, service?}`. Attaches a custom domain to a public service and returns the DNS
records the user must create. HTTPS is issued once DNS resolves.

### destroy

`{project, approval_token?}`. Deletes the project, its services and all data. Needs an `admin`
key and the user's approval: the first call returns `needs_approval` with `approval.url` (valid 15
minutes). After the user approves in the browser they paste back a one-time `approval_token`;
call again with it. (`confirm_token` is the dashboard's flow.)

### upgrade

`{plan?: hobby|pro|team, interval?: month|year}`; remote also takes `currency?: usd|inr`. Returns
a payment link for the user. Remote defaults to the next plan, yearly; local defaults to Hobby,
monthly. Call only when the user asks.

### list_projects

`{}`. The user's projects with URLs, status and role (remote also returns `plan`).

### verify

`{project}`. Runs live verification without redeploying; returns a `VerificationReport`.

### issues

`{project, status?: open|resolved|dismissed|all, severity?: critical|warning|info, limit?: 1-100,
offset?}`. Persistent verification, security and production issues.

### issue_resolve

`{project, id, status: resolved|dismissed}`. A resolved issue reopens if it recurs; a dismissal is
remembered for the project.

### verify_fix

`{project, consent: true, issue_ids?, fixes?}`. Applies only allowlisted fixes (canonical URL env
var, same-project CORS origin, safe security headers), then verifies again. Never changes code or
schemas. Requires the user's consent.

### verify_journey

`{project, journey}`. Runs a saved plain-language journey with the project's consented test
account in an isolated browser. No payment, deletion or non-login writes.

### import, import_status, import_cutover, import_undo

Move an app from Vercel, Render, Railway, Heroku or Docker Compose. `import` actions: `scan`
(default), `approve`, `deploy`, `copy`, `sync`; each non-scan step needs `id` and a
fresh revision-bound `approval` (`expectedRevision`, `planDigest`, `approve: true`).
`import_status` `{project, id}` reads progress (poll until `operation` is absent).
`import_cutover` switches DNS; `import_undo` restores DNS within seven days and needs
`acknowledgeDnsOnlyUndo: true`. The source host is never deleted. Ask the user before every
approval and never read provider credentials from local files.

## CLI commands

Run with `npx rivtor <command>` or a global install. Most commands accept `--json` and
`-p, --project <slug>`.

| Command | Purpose |
| --- | --- |
| `rivtor login [--token <t>] [--api-url <url>]` | Save a token (interactive input is hidden). |
| `rivtor logout` / `rivtor whoami [--json]` | Remove the token / show account and plan. |
| `rivtor deploy [path] [-p <slug>] [--dry-run] [--json] [--no-wait] [--env-file <file>] [--clean] [--no-verify]` | Deploy a folder. Exit `0` live, `1` failed, `2` needs input. |
| `rivtor status [project] [--json]` | Services, URLs, data, last deploy and verdict. |
| `rivtor projects [--json]` | List projects. |
| `rivtor logs [project] [-s <service>] [--since 1h] [--level error] [-n <n>] [--raw] [--build <deploymentId>]` | Runtime logs, or a deployment's build log. |
| `rivtor env set K=V [K2=V2 ...] [-s <service>]` | Set variables (restart, no rebuild). |
| `rivtor env rm K [K2 ...] [-s <service>]` / `rivtor env ls` | Remove / list variables (values masked). |
| `rivtor env pull [-f <file>] [--production] [--include-secrets] [--force]` | Write env vars to `.env.local` / `.env` for local development (secrets left out unless asked; adds `.env*` to `.gitignore`). |
| `rivtor rollback [releaseId]` | Roll back to the previous or a specific release. |
| `rivtor db query "<sql>"` / `rivtor db url` / `rivtor db export -o <file>` | Read-only SQL / temporary connection string / `pg_dump`. |
| `rivtor db connect [--port 54329]` | Authenticated tunnel to the project's Postgres on localhost (Node 22+). |
| `rivtor domain add <hostname> [-s <service>]` | Attach a domain; prints the DNS record. |
| `rivtor destroy [project] [--confirm <slug>] [--approval-token <rva_...>]` | Delete a project and all data (API keys: after the user's approval). |
| `rivtor upgrade [hobby\|pro\|team] [--interval month\|year] [--currency usd\|inr] [--provider stripe\|razorpay] [--no-open]` | Checkout link. |
| `rivtor verify [project] [--json]` | Re-check the live app. Exit `0` only for `working`. |
| `rivtor issues [project] [--status open\|resolved\|dismissed\|all] [--severity <s>]` | List issues. |
| `rivtor issue-resolve <id> [-p <slug>] [--dismiss]` | Resolve or dismiss one issue. |
| `rivtor verify-fix <ids...> [-p <slug>] --yes` | Apply allowlisted fixes with consent. |
| `rivtor import [path] [--source vercel\|render\|railway\|heroku\|compose\|auto] ...` | Plan an import; `--execute` with approval runs it. |
| `rivtor mcp` | Run the local MCP server over stdio. |
| `rivtor skills install [--target claude\|codex\|cursor\|all] [--project]` / `rivtor skills path` | Install this skill / print its bundled folder. |

`--env-file <file>` sends variables from a dotenv file with the deploy without uploading the file.
`--no-wait` only stops waiting; it does not disable verification.

## Project resolution

Local MCP and CLI pick the project slug in this order: the `project` argument / `--project`,
then `rivtor.json` (`{ "project": "my-app" }`) in the folder, then the folder name. After the
first deploy the CLI writes `rivtor.json` so later deploys go to the same project.
