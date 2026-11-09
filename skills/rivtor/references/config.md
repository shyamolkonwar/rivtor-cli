# Rivtor configuration, detection, data and limits

## Contents

- [Detection](#detection)
- [deploy.toml](#deploytoml)
- [Data services and injected env](#data-services-and-injected-env)
- [Uploads](#uploads)
- [Plans and limits](#plans-and-limits)

## Detection

No config file is required. Rivtor walks the repo; every folder with its own manifest
(`package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Dockerfile`, ...) is a candidate
service, named after its folder (`web`, `api`). Turborepo, pnpm/npm workspaces and Nx are read to
find app folders. A single-app repo is one service.

| Signal | Service | Runs on |
| --- | --- | --- |
| Vite, Astro, plain HTML, CRA, Next.js static export | Static site | Cloudflare edge |
| Next.js with SSR, API routes or server actions | Web app | Container |
| Express, Fastify, NestJS, Hono | Node API | Container |
| FastAPI, Flask, Django | Python API | Container |
| Go, Rust, Ruby, Java, PHP and others | Generic app | Container, built with Railpack |
| `Dockerfile` present | Custom | Container; the Dockerfile wins |
| Celery, BullMQ, RQ worker entrypoints | Worker | Container, no public URL |

Data needs come from code: Prisma, Drizzle, TypeORM, `pg`, SQLAlchemy, psycopg, Django ORM →
Postgres; `redis`, `ioredis`, Celery, BullMQ, RQ → Redis; multer, S3 SDKs, boto3, `UploadFile` →
R2 object storage. A variable read in code (`process.env.X`, `os.environ["X"]`) with no value
becomes a missing secret (`needs_input`). `.env.example` tells detection which names the app
expects.

Wiring: a frontend reading `NEXT_PUBLIC_API_URL` or `VITE_API_URL` gets the API's public URL at
build time. Services in one project share a private network and reach each other by name
(`http://api:8000`).

Hostnames: the primary public service gets `<slug>.rivtor.app`; other public services get
`<slug>-<service>.rivtor.app`. Workers get none. Custom domains attach with `domain_add`.

Migrations: when a migration tool is detected, its command (`prisma migrate deploy`,
`alembic upgrade head`, `python manage.py migrate`) runs against the database before release.

Assumptions are listed in `plan.assumptions` with the `deploy.toml` key that changes them. Run
`deploy` with `dry_run: true` to see them.

Remote starters for `deploy` `starter`: `nextjs-fastapi-postgres`, `express-postgres`,
`vite-static`.

## deploy.toml

Optional, at the repo root. Every key overrides only the field it names. Keys may be camelCase
(`rootDir`) or snake_case/kebab-case (`root_dir`, `root-dir`). Unknown keys and wrong types are
rejected with a message naming the key. Top-level `project`/`name` is tolerated but ignored.

```toml
ignore = ["fixtures/**", "*.mp4"]

[services.web]
root_dir = "web"
framework = "nextjs"
build_command = "pnpm build"
start_command = "pnpm start"
port = 3000

[services.api]
root_dir = "api"
kind = "api"
start_command = "uvicorn main:app --host 0.0.0.0 --port 8000"
port = 8000
health_path = "/health"
migrate_command = "alembic upgrade head"
data = ["postgres", "redis"]

[services.api.env]
LOG_LEVEL = "info"

[services.worker]
root_dir = "worker"
kind = "worker"
start_command = "celery -A tasks worker"
public = false

[verify]
exclude = ["/admin"]
routes = ["/pricing"]
```

### `[services.<name>]` keys

| Key | Aliases | Type | Meaning |
| --- | --- | --- | --- |
| `rootDir` | `root_dir`, `root`, `path` | string | Service folder relative to the repo root (`"."` for root). Must stay inside the repo. |
| `kind` |  | `static`, `web`, `api`, `worker`, `custom` | What the service is; decides where it runs and whether it gets a URL. |
| `framework` |  | string | e.g. `nextjs`, `vite`, `astro`, `express`, `fastapi`, `django`. |
| `builder` |  | `static`, `railpack`, `dockerfile` | How it is built. A Dockerfile in `rootDir` selects `dockerfile`. |
| `buildCommand` | `build_command`, `build` | string | Build command. |
| `startCommand` | `start_command`, `start` | string | Start command (not for static). Must listen on `0.0.0.0:$PORT` or the `port` below. |
| `outputDir` | `output_dir` | string | Static output folder relative to `rootDir`. |
| `port` |  | integer 1 to 65535 | Port the app listens on. `PORT` is also injected. |
| `healthPath` | `health_path`, `health_check`, `healthcheck` | string | Path that must answer before traffic moves. Default `/`. |
| `migrateCommand` | `migrate_command`, `migrate` | string | Runs against the database before release. |
| `public` |  | boolean | `false` for services without a URL. |
| `data` |  | list of `postgres`, `redis`, `r2`, `mysql`, `mongodb` | Replaces (does not add to) what detection found for this service. |
| `env` |  | table `KEY = "value"` | Non-secret variables. Numbers and booleans become strings. |
| `workload` |  | table | Advanced: `protocol` (`http`/`grpc`/`tcp`), `schedule` (five-field UTC cron), `command`, `entrypoint`, `image`, `dockerfile`, `volumes`. |

### Top-level keys

| Key | Meaning |
| --- | --- |
| `ignore` | Gitignore-style patterns detection skips. To keep files out of the upload, use `.gitignore` or `.rivtorignore`. |
| `[verify]` | `exclude` (paths skipped by verification), `routes` (extra paths to check), both starting with `/`; `enabled` (boolean); `browser_errors` (boolean, opt-in browser error script). |

Never put secrets in `deploy.toml`; it is committed. Use `env_set` or `rivtor env set`.

## Data services and injected env

Created when detection finds code that needs them or `data` lists them. Credentials are injected
at runtime and are read-only (`env_read_only`).

| Service | Variables |
| --- | --- |
| Postgres 17 | `DATABASE_URL`, `DIRECT_DATABASE_URL` (same in v1, for Prisma), `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` |
| Redis 7 | `REDIS_URL` |
| R2 object storage | `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` (`auto`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, plus `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL_S3` |

Always injected: `PORT`, `NODE_ENV`, `HOST`.

Postgres: one database and role per project, through PgBouncer (transaction mode, port 6432),
20 connections per role, 60 s statement timeout, no public endpoint (use `db`). Over the size
limit it becomes read-only until space is freed or the plan is upgraded. Redis evicts least
recently used keys when full (`allkeys-lru`); use it as cache and queue, not the only copy of
data. R2 speaks the S3 API: point an S3 SDK at `S3_ENDPOINT` with region `auto`. Databases never
sleep.

## Uploads

- Packing follows `.gitignore` (nested too) and `.rivtorignore`.
- `node_modules`, `.git`, build outputs (`dist`, `build`, `out`, `.next`), virtualenvs and caches
  are skipped.
- `.env` files are never uploaded. Only `.env.example`, `.env.sample` and `.env.template` are,
  so detection can read variable names.
- Limit: 300 MB compressed (changed files only on redeploys). Remote inline `files`: 2 MB.

## Plans and limits

|  | Free | Hobby | Pro | Team |
| --- | --- | --- | --- | --- |
| Price (USD/month) | 0 | 19 | 49 | 199 |
| Projects | 3 | 5 | unlimited | unlimited |
| Services per project | 3 | 5 | 10 | 20 |
| Container RAM | 512 MB per app | 1 GB total | 3 GB total | 10 GB total |
| Always on | no, sleeps after 60 min idle | yes | yes | yes |
| Postgres | 1 GB per project | 5 GB | 20 GB | 80 GB |
| Redis | 50 MB | 100 MB | 256 MB | 1 GB |
| File storage | 1 GB | 10 GB | 50 GB | 200 GB |
| Custom domains | 1 | 3 | 20 | 50 |
| Teammates | no | no | yes | yes |
| Production re-checks | none | daily | every 15 min | every 5 min |

- Free and Hobby stop at a limit and offer an upgrade; Pro and Team bill overage up to a spend
  cap. Nothing running is deleted.
- Builds get 15 minutes and 4 GB of memory.
- Sleep and wake (Free): container apps sleep after 60 minutes without a request and wake on the
  next request in about a second; the first request waits. Static sites and databases never
  sleep. Paid plans are always on.
- Free is for personal, non-commercial projects; phone or card verification is required before
  an app can stay always on or use a custom domain.
- Yearly billing pays for 10 months. Upgrades go through the `upgrade` tool or
  `rivtor upgrade`, only when the user asks.
