# Rivtor error codes

Every failed deploy carries `error.code`. The `fix` text in the response is specific to the app
(package names, file and line); prefer it over this summary. Build and runtime fixes end with
"then call deploy again".

## Contents

- [Resources](#resources)
- [Ports and start commands](#ports-and-start-commands)
- [Docker and builder](#docker-and-builder)
- [Node.js dependencies](#nodejs-dependencies)
- [Frontend builds](#frontend-builds)
- [Python](#python)
- [Go and Rust](#go-and-rust)
- [Env vars and data services](#env-vars-and-data-services)
- [Migrations](#migrations)
- [Transient and unknown](#transient-and-unknown)
- [Platform codes](#platform-codes)
- [Verification issue codes](#verification-issue-codes)

## Resources

| Code | Fix |
| --- | --- |
| `out_of_memory` | Build: set `NODE_OPTIONS=--max-old-space-size=3072` in the build command, disable source maps, build less in parallel. Runtime: fewer workers (`gunicorn -w 2`), smaller caches, stream large files. Carries an `upgrade` hint; the user decides on upgrading. |
| `build_timeout` | Builds have 15 minutes. Commit the lockfile so installs cache, drop heavy unused dependencies, don't build in watch/dev mode, avoid pre-rendering thousands of pages. |
| `disk_full` | Build: don't commit large binaries/datasets, don't download models at build time. Runtime: the container disk is ephemeral; store files in object storage (`S3_*`), rotate or disable file logging. |
| `segfault` | Upgrade or replace native dependencies (`bcrypt` → `bcryptjs`, latest `sharp`/`canvas`/`better-sqlite3`); never commit `node_modules` or `.venv`. |

## Ports and start commands

The app must listen on `0.0.0.0` and the port in `PORT`, e.g.
`app.listen(process.env.PORT || 3000, '0.0.0.0')`, `uvicorn main:app --host 0.0.0.0 --port $PORT`,
`gunicorn -b 0.0.0.0:$PORT app:app`.

| Code | Fix |
| --- | --- |
| `bound_to_localhost` | Bind to `0.0.0.0` instead of `127.0.0.1`/`localhost`. |
| `wrong_port` | Read `PORT` instead of a hard-coded port, or set `port = <n>` for the service in `deploy.toml`. |
| `health_check_timeout` | The app did not answer HTTP within 60 s. Check startup logs, listen on `0.0.0.0:$PORT`, make the health path return 2xx/3xx quickly (set `healthPath` in `deploy.toml` if `/` is slow or needs auth). |
| `port_in_use` | Start exactly one server process on `$PORT` (no duplicate `listen()`, no second server on import). |
| `permission_denied` | Privileged port (e.g. 80): listen on `$PORT`. Script: make it executable (`git update-index --chmod=+x <file>`) or run it via `sh`. File write: write only to `/tmp` or the app directory; persist in object storage. |
| `dev_server_in_production` | Use a production start command (`next start`, `vite preview --host 0.0.0.0 --port $PORT`, or deploy as static) in `package.json` or `startCommand`. |
| `file_watcher_limit` | A dev/watch command is running. Start the production server (`next start`, `node dist/index.js`). |
| `railpack_no_start_command` | Add a `start` script, a `Procfile` (`web: <command>`), or `startCommand` in `deploy.toml`. |
| `missing_start_script` | Add a `start` script that runs the production server on `$PORT`, or set `startCommand`. |
| `node_entry_not_found` | The start file does not exist: add a `build` script that produces it (check `outDir`) or point `start`/`startCommand` at the real entry. Gitignored files are not uploaded. |
| `asgi_app_not_found` | Name the right module and app object relative to the service folder, e.g. `uvicorn app.main:app --host 0.0.0.0 --port $PORT`; override with `startCommand`. |

## Docker and builder

| Code | Fix |
| --- | --- |
| `dockerfile_copy_failed` | The build context is the service folder. The file must exist there, not be in `.dockerignore`/`.gitignore`, and COPY paths must be relative to the service folder. |
| `dockerfile_syntax_error` | Fix the Dockerfile at the reported line (instruction spelling, `\` continuations). |
| `docker_base_image_not_found` | Use a public image with an existing tag in `FROM` (e.g. `node:22-slim`, `python:3.12-slim`). |
| `railpack_unsupported` | The service root needs its manifest (`package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, ...), or add a Dockerfile, or set `rootDir`. |
| `crlf_line_endings` | Convert scripts to LF (`*.sh text eol=lf` in `.gitattributes` + `git add --renormalize .`, or `dos2unix`). |
| `exec_format_error` | Don't commit compiled binaries or `node_modules`/`.venv`; build in the image (linux/amd64); start scripts with a shebang such as `#!/bin/sh`. |
| `command_not_found` | Add the tool as a dependency: `uvicorn[standard]`/`gunicorn`/`celery`/`alembic` to `requirements.txt`; `next`/`vite`/`typescript`/`prisma`/... to `package.json` `dependencies` when needed at runtime; for `pnpm`/`yarn`/`bun` add a `packageManager` field and commit the matching lockfile. |
| `missing_system_library` | Use a variant without the system library, e.g. `opencv-python-headless` instead of `opencv-python`, or install it with a Dockerfile. |

## Node.js dependencies

| Code | Fix |
| --- | --- |
| `missing_node_module` | Add the package to `dependencies` (not `devDependencies`: dev deps are pruned from the runtime image) and commit the updated lockfile. |
| `node_local_import_not_found` | Fix the relative import: Linux paths are case-sensitive, the file must be committed, and ESM imports need the extension (`./x.js`). |
| `node_esm_cjs_mismatch` | Align module formats: add `"type": "module"` or use `.mjs`/`.cjs`; replace `__dirname`/`require` in ESM; use `await import()` or pin the last CommonJS version of an ESM-only package; run compiled `dist/`, not `.ts`. |
| `lockfile_missing` | Run the package manager's install locally and commit the lockfile; make sure it is not gitignored. |
| `lockfile_out_of_date` | Run `npm install` / `pnpm install` / `yarn install` in the service folder and commit the updated lockfile. |
| `npm_peer_conflict` | Align versions so the peer requirement is satisfied, or add `legacy-peer-deps=true` to `.npmrc` in the service folder; commit the lockfile. |
| `npm_package_not_found` | Fix the package name/version (typos, unpublished versions). For private packages set `NPM_TOKEN` with `env_set` and add an `.npmrc` that uses it. |
| `node_version_mismatch` | Pin Node in `package.json` (`"engines": { "node": "22.x" }`) or `.nvmrc`/`.node-version`; upgrade incompatible dependencies. |
| `native_module_build_failed` | Replace with a prebuilt/pure-JS package (`bcrypt` → `bcryptjs`, `node-sass` → `sass`, `canvas` → `@napi-rs/canvas`) or upgrade to a version with Node 22 binaries. |
| `prisma_client_not_generated` | Add `"postinstall": "prisma generate"` (or prefix the build with `prisma generate &&`), keep `prisma` in dependencies; for engine errors add `binaryTargets = ["native", "debian-openssl-3.0.x"]`. |
| `missing_build_script` | Add a `build` script, or set `buildCommand`/`outputDir`; for plain HTML set `kind = "static"` and `buildCommand = ""`. |

## Frontend builds

| Code | Fix |
| --- | --- |
| `typescript_error` | Fix the type error at `error.file`; run `tsc --noEmit` locally to see them all. |
| `eslint_build_failure` | Fix the lint error, or set `eslint: { ignoreDuringBuilds: true }` in `next.config` (CRA: `CI=false react-scripts build`). |
| `vite_unresolved_import` | Add the missing package to `dependencies`, or fix the import path (case-sensitive, committed, not gitignored). |
| `next_missing_suspense` | Wrap the component that calls `useSearchParams()` in `<Suspense fallback={null}>`, or add `export const dynamic = 'force-dynamic'` to the page. |
| `next_dynamic_server_usage` | Add `export const dynamic = 'force-dynamic'` to the page/route, or stop calling dynamic APIs during render. |
| `next_static_export_unsupported` | With `output: 'export'`: add `generateStaticParams()`, set `images: { unoptimized: true }`, or remove `output: 'export'` to deploy as a server app. |
| `next_prerender_error` | Fix the error thrown while pre-rendering the route (guard code that needs runtime env or the database), or make the page `force-dynamic`. |
| `static_output_missing` | Set `outputDir` to the folder the build writes (`dist`, `build`, `out`), or configure the build to write there. |

## Python

| Code | Fix |
| --- | --- |
| `missing_python_module` | Add the package to `requirements.txt` / `pyproject.toml`. If it is a local package, run from the folder that contains it, add `__init__.py`, or set `rootDir`/`startCommand`. |
| `python_import_error` | Pin the package to the version the code was written for (check `pip freeze`), or fix the circular import. |
| `python_syntax_error` | Fix the syntax at `error.file`; check the code doesn't need a newer Python (pin with `.python-version`). |
| `missing_requirements_file` | Add `requirements.txt` (`pip freeze > requirements.txt`) or declare dependencies in `pyproject.toml`. |
| `python_version_incompatible` | Pin Python with `.python-version` (e.g. `3.12`) or `requires-python`, or choose package versions that support it. |
| `pip_resolution_conflict` | Relax or align conflicting pins and regenerate the lockfile if any. |
| `python_package_not_found` | Fix the package name/version (check PyPI and supported Python versions). |
| `python_wheel_build_failed` | Use a package with wheels (`psycopg2` → `psycopg2-binary` or `psycopg[binary]`), upgrade it, or pin Python 3.12. |
| `django_disallowed_host` | `ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", ".rivtor.app,localhost").split(",")` (plus custom domains) and `CSRF_TRUSTED_ORIGINS = ["https://*.rivtor.app"]`. |
| `django_csrf_origin` | Add the app's https origins to `CSRF_TRUSTED_ORIGINS`. |
| `django_improperly_configured` | Fix the reported setting, e.g. `STATIC_ROOT = BASE_DIR / "staticfiles"` for collectstatic. |

## Go and Rust

| Code | Fix |
| --- | --- |
| `go_version_mismatch` | Lower the `go` directive in `go.mod` to a released version (e.g. `go 1.23`) and remove an undownloadable `toolchain` line. |
| `go_module_missing` | Run `go mod tidy` in the service folder and commit `go.mod` and `go.sum`. |
| `go_compile_error` | Fix the error at `error.file` (`go build ./...` locally). |
| `rust_toolchain_too_old` | Pin a newer toolchain in `rust-toolchain.toml` (`[toolchain] channel = "stable"`) or downgrade the crate. |
| `rust_compile_error` | Fix the error at `error.file` (`cargo build --release` locally). |

## Env vars and data services

| Code | Fix |
| --- | --- |
| `missing_env_var` | Status `needs_input`. Ask the user for the listed variables, `env_set`, deploy again. |
| `missing_env_at_build` | Same, for variables read during the build (e.g. `NEXT_PUBLIC_*`). |
| `data_service_not_provisioned` | `DATABASE_URL`/`REDIS_URL`/`S3_*` is missing because detection found no client library. Add `data = ["postgres"]` (or `"redis"`, `"r2"`) under `[services.<name>]` in `deploy.toml`, or add the client library. |
| `db_connection_refused` | Read `DATABASE_URL` from env instead of hard-coding `localhost`. |
| `db_auth_failed` | Use the injected `DATABASE_URL`; don't hard-code credentials or override `DATABASE_URL`/`PG*` (remove overrides with `env_set` `remove` or `rivtor env rm`). |
| `db_schema_missing` | Tables don't exist: add migrations and a migrate command (`prisma migrate deploy`, `alembic upgrade head`, `python manage.py migrate`, `drizzle-kit migrate`); set `migrateCommand` if detection missed it. |
| `redis_connection_refused` | Read `REDIS_URL` from env; add `data = ["redis"]` if detection missed it. |
| `celery_broker_unreachable` | `broker=os.environ["REDIS_URL"]` (and backend) instead of a hard-coded localhost/amqp URL; add `data = ["redis"]` to the worker. |

## Migrations

A failed migration stops the release; the previous release keeps serving.

| Code | Fix |
| --- | --- |
| `prisma_migration_failed` | Fix the migration SQL (it must work on a database with data). A migration recorded as failed: prefix `migrateCommand` with `npx prisma migrate resolve --rolled-back <name> && ` for one deploy. |
| `alembic_migration_failed` | Multiple heads: `alembic merge heads -m merge` and commit. Missing revision: restore and commit the revision file, or stamp a known revision. |
| `django_migration_failed` | Conflicts: `python manage.py makemigrations --merge` and commit. Missing files: commit every file in `*/migrations/`. |
| `migration_failed` | Make the migration apply cleanly to the existing database (e.g. `IF NOT EXISTS`), or correct `migrateCommand`. |

## Transient and unknown

| Code | Fix |
| --- | --- |
| `registry_network_error` | Transient package-registry error. Nothing to change; wait a few seconds and deploy again (once). |
| `unknown` | No known pattern matched. Read `error.logTail`, then `logs` with `deployment_id`; fix the first real error line. |

## Platform codes

| Code | Stage | Action |
| --- | --- | --- |
| `not_logged_in`, `unauthorized` | auth | Ask the user to run `npx rivtor login` (or reconnect the MCP server / sign in again). |
| `token_prefix_only` | auth | The 12-character prefix is not a token. The user creates a new token (44 chars) and copies it at once. |
| `token_expired` | auth | The user creates a new token at https://rivtor.com/dashboard/tokens. |
| `too_many_auth_failures` | auth | Wait 10 minutes, then retry with a valid token. |
| `forbidden`, `not_found` | auth | Wrong project or role. Call `list_projects`; ask the owner for access. |
| `invalid_project`, `invalid_project_name` | upload/plan | Use a slug of lowercase letters, digits and dashes. |
| `project_name_taken` | plan | Pick another project name. |
| `missing_secrets` | plan | Status `needs_input`: ask for each secret, `env_set`, deploy again. |
| `nothing_to_deploy`, `empty_source` | upload/plan | Deploy the folder that contains the manifest (`package.json`, `requirements.txt`, `go.mod`, `Dockerfile`, `index.html`); check the path and `.gitignore`. |
| `source_too_large`, `too_many_files` | upload | Upload limit is 300 MB (remote `files` 2 MB). Exclude `node_modules`, build output and large assets via `.gitignore`/`.rivtorignore`. |
| `invalid_git_url` | upload | Use a public `https://github.com/<user>/<repo>` URL, or deploy a local folder. |
| `verification_failed` | release | Candidate blocked; previous release still serving. Fix `verification.issues`, deploy again. |
| `provision_failed`, `interrupted`, `engine_unavailable` | provision/release | Usually transient: deploy again once; if it persists, contact support@rivtor.com. |
| `wait_timeout` | return | Still deploying; poll `status`. |
| `blocked_by_abuse_scan`, `project_suspended`, `account_suspended` | upload/auth | Stop. The user contacts abuse@rivtor.com / support@rivtor.com. |
| `project_limit`, `service_limit`, `domain_limit` | limits | Plan limit. Tell the user; `error.upgrade.url` / `upgrade` tool if they want to upgrade. |
| `always_on_not_included`, `teammates_not_included`, `journey_limit`, `watch_plan_required` | limits | Feature not in the plan. Same: inform, upgrade only on request. |
| `verification_required` | domain | Account verification needed for custom domains on Free; the user verifies in dashboard settings. |
| `rate_limited` | any | Wait the stated time, then retry. |
| `billing_not_configured`, `already_subscribed`, `invalid_plan` | limits | Payment setup problem or already on that plan; tell the user. |
| `invalid_env_key`, `invalid_arguments`, `invalid_request` | env | Pass `set`/`vars` and/or `remove`; keys are letters, digits, `_`, not starting with a digit. |
| `env_read_only` | env | Rivtor-managed variables can't be changed; use a different name. |
| `domain_taken`, `reserved_hostname`, `platform_hostname`, `invalid_hostname` | domain | Use a domain the user owns, no scheme or path, not attached elsewhere. |
| `no_public_service`, `service_not_found`, `service_not_public` | domain | Deploy first, or pass a deployed public service name from `status`. |
| `no_database` | db | The project has no Postgres yet (detection found none). |
| `query_timeout`, `read_only_query`, `query_failed`, `empty_query`, `sql_too_long` | db | `db` `query` is read-only, 5 s, 500 rows, max 20,000 chars. Narrow the query; writes go through app code or migrations. |
| `nothing_to_roll_back` | rollback | Deploy at least twice, or pass a `release_id`. |
| `release_not_found`, `release_expired`, `release_not_usable` | rollback | Pick a newer release that was live; only the last 5 can be restored. |
| `invalid_confirm_token` | return | Call `destroy` without a token again for a fresh one (valid about 10 minutes). |
| `approval_required` | auth | Status `needs_approval`: give the user `approval.url`; after they approve, repeat the call with the `approval_token` they paste back (single use, 15 minutes). |
| `token_scope` | auth | The token's scope or project limit doesn't allow this call. The user creates a token with the scope (`read`, `deploy`, `admin`) or project named in `fix`. |
| `session_required` | auth | Approvals are decided by the user in the browser, never with an API token. |
| `verify_sleeping` | return | Request the app URL to wake it, then `verify`. |
| `verify_plan_missing` | return | Deploy once, then `verify`. |
| `client_error`, `cli_error` | any | Local client problem; retry, or run the equivalent `rivtor` CLI command to see details. |

## Verification issue codes

Found in `verification.issues[]` and `issues`. Blocking issues make the verdict `broken`.

| Code | Check | Fix |
| --- | --- | --- |
| `client_secret` | security | A known secret is in a public response or client bundle. Move it to server-side env (no `NEXT_PUBLIC_`/`VITE_` prefix), tell the user to rotate it, deploy again. Always blocks. |
| `source_secret` | security | A credential appears in uploaded source. Move it to env vars and have the user rotate it. |
| `security_unverified` | security | A public response could not be fully scanned; use a supported encoding and keep responses within the size limit. |
| `unreachable`, `redirect_loop`, `invalid_tls`, `tls_unverified` | reachability | The health URL failed. Fix the start command/port, redirects or HTTPS handling. |
| `runtime_unhealthy`, `runtime_unverified`, `cron_unverified` | reachability | The release is not running/healthy or could not be observed; check `status` and runtime `logs`. |
| `verification_timeout`, `verification_incomplete` | reachability | Retry `verify`. An incomplete check never promotes a candidate. |
| `page_failed`, `browser_incomplete` | pages | A page errored or did not render (status, console or network errors). Fix the route in `where`. A failing `/` blocks. |
| `api_failed` | api | A discovered API route returned 5xx. Fix the handler in `where`. |
| `openapi_unreadable` | api | The declared OpenAPI document could not be read. |
| `cors_blocked` | api | The API does not allow the frontend origin. Allow it in the API's CORS config, or `verify_fix` (`cors_origin`) with consent. |
| `missing_env` | config | A variable the code reads is unset. Ask the user, `env_set`, deploy. |
| `wrong_live_url`, `localhost_config` | config | A URL env var points to a local or wrong address. Set it to the live service URL (`fix_action` `set_env_url`; `verify_fix` with consent). |
| `migration_pending`, `seed_empty`, `seed_unverified`, `data_check_failed`, `data_connection_unverified`, `data_unverified` | data | Apply migrations (`migrateCommand`), seed required tables, and connect through the injected `DATABASE_URL`. |

Production watch also records dependency vulnerabilities (upgrade to the fixed version shown),
publicly readable Supabase tables or Firebase paths, listable storage buckets, exposed debug
pages (`DEBUG=False`) and missing security headers (`verify_fix` with consent).
