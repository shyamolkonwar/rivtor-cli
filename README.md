# rivtor

Deploy any app (frontend, backend, workers, Postgres, Redis and object storage) with one command, from your terminal or from an AI agent.

```bash
npx rivtor login
npx rivtor deploy
```

Rivtor detects every service in the folder (Next.js, Vite, Astro, Express, Fastify, NestJS, FastAPI, Flask, Django, Go, Rust, Dockerfile and more), provisions the databases your code needs, wires service URLs together and returns live URLs, usually in about two minutes.

## Install

```bash
npm i -g rivtor     # or run it with npx: npx rivtor <command>
```

You need Node.js 20 or newer.

## Log in

Create a token at <https://rivtor.com/dashboard/tokens>, then run:

```bash
rivtor login                    # paste the token when asked (input is hidden)
rivtor login --token rvt_...    # non-interactive
```

The token is saved to `~/.config/rivtor/config.json` with mode `0600` (or `$XDG_CONFIG_HOME/rivtor`). In CI, set `RIVTOR_TOKEN` instead. `RIVTOR_API_URL` changes the API endpoint (default `https://api.rivtor.com`).

## Deploy

```bash
rivtor deploy                   # deploy the current folder
rivtor deploy ./my-app          # deploy another folder
rivtor deploy --dry-run         # print the detected plan; nothing is deployed
rivtor deploy --env-file .env.production   # send these variables with the deploy
rivtor deploy --no-wait         # start and exit right away
rivtor deploy --json            # print the raw DeployResult (for scripts and agents)
rivtor deploy --clean           # rebuild everything from scratch, without build/dependency caches
```

Redeploys upload only the files that changed: the CLI sends a list of file hashes, and the API asks
for the files it doesn't have yet. Dependencies are cached per account and reused until a lockfile,
the runtime version or the build env changes. Use `--clean` if a cached dependency ever looks stale.

What gets uploaded:

- Files are packed according to your `.gitignore` files (nested ones too) and an optional `.rivtorignore`.
- `node_modules`, `.git`, build outputs (`dist`, `build`, `out`, `.next`, ...), virtualenvs and caches are skipped.
- **`.env` files are never uploaded**, even if your `.gitignore` allows them. Only `.env.example`, `.env.sample` and `.env.template` are uploaded, so Rivtor can see which variable names your app expects. To send secret values, use `--env-file` or `rivtor env set`.
- The upload limit is 300 MB compressed (for a redeploy: the changed files only).

The project name comes from `--project <slug>`, then from `rivtor.json` (`{ "project": "my-app" }`), then from the folder name. After the first deploy the CLI writes `rivtor.json` so later deploys go to the same project.

Exit codes: `0` live, `1` failed, `2` needs input (for example a missing secret). When a deploy fails, the CLI prints the cause, the file and line, and the fix.

## Commands

| Command                                                                                           | What it does                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `rivtor login [--token <t>]`                                                                      | Save an API token                                                 |
| `rivtor logout`                                                                                   | Remove the saved token                                            |
| `rivtor whoami`                                                                                   | Show the logged-in account and plan                               |
| `rivtor deploy [path] [--project] [--dry-run] [--json] [--no-wait] [--env-file] [--clean]`        | Deploy a folder                                                   |
| `rivtor status [project]`                                                                         | Services, URLs, data services and the last deploy                 |
| `rivtor projects`                                                                                 | List your projects                                                |
| `rivtor logs [project] [--service] [--since 1h] [--level error] [--raw] [--build <deploymentId>]` | Runtime logs, or a deployment's build log                         |
| `rivtor env set K=V [K2=V2 ...] [--service]`                                                      | Set env vars and secrets (services restart; no rebuild)           |
| `rivtor env rm K [K2 ...] [--service]`                                                            | Remove env vars                                                   |
| `rivtor env ls`                                                                                   | List env vars (values masked)                                     |
| `rivtor rollback [releaseId]`                                                                     | Roll back to the previous release, or to a specific one           |
| `rivtor db query "<sql>"`                                                                         | Run read-only SQL                                                 |
| `rivtor db url`                                                                                   | Get a temporary connection string (valid for 1 hour)              |
| `rivtor db export -o backup.dump`                                                                 | Download a `pg_dump` in custom format                             |
| `rivtor domain add <hostname> [--service]`                                                        | Attach a custom domain and print the DNS record to create         |
| `rivtor destroy [project]`                                                                        | Delete a project and all its data; you confirm by typing the slug |
| `rivtor upgrade [hobby\|pro\|team] [--interval month\|year]`                                      | Open a checkout link                                              |
| `rivtor mcp`                                                                                      | Run the MCP server over stdio                                     |

Most commands accept `--json` and `--project <slug>`.

## Use it from AI agents (MCP)

`rivtor mcp` runs a local MCP server over stdio. It has the same tools as the remote server, and its `deploy` tool can upload a folder straight from disk:

`deploy`, `status`, `logs`, `env_set`, `rollback`, `db`, `domain_add`, `destroy`, `upgrade`, `list_projects`

With these tools an agent can fix its own failed deploys. When a deploy fails, the agent gets a structured error with `cause`, `file` and `fix`. It edits the code and calls `deploy` again, and only the services that changed are rebuilt. If a secret is missing, the agent asks you for it once, then calls `env_set`. Secret values are never echoed back.

### Claude Code

```bash
claude mcp add rivtor -e RIVTOR_TOKEN=rvt_... -- npx -y rivtor mcp
```

If you already ran `rivtor login`, you can leave out `-e RIVTOR_TOKEN=...`:

```bash
claude mcp add rivtor -- npx -y rivtor mcp
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "rivtor": {
      "command": "npx",
      "args": ["-y", "rivtor", "mcp"],
      "env": { "RIVTOR_TOKEN": "rvt_..." }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.rivtor]
command = "npx"
args = ["-y", "rivtor", "mcp"]
env = { RIVTOR_TOKEN = "rvt_..." }
```

### Remote MCP (no local install)

Agents that don't need to upload files from disk can connect to `https://api.rivtor.com/mcp` with the header `Authorization: Bearer rvt_...`. The remote `deploy` tool accepts a git URL, a starter template or inline files.

## License

MIT
