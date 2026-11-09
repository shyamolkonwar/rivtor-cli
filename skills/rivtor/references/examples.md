# Rivtor worked examples

Short transcripts of the core loop. JSON is trimmed to the fields that matter.

## Contents

- [1. First deploy: Next.js + FastAPI + Postgres](#1-first-deploy-nextjs--fastapi--postgres)
- [2. Failed build: missing module](#2-failed-build-missing-module)
- [3. needs_input: missing secret](#3-needs_input-missing-secret)
- [4. Production issue: fix, verify, resolve](#4-production-issue-fix-verify-resolve)

## 1. First deploy: Next.js + FastAPI + Postgres

User: "Put this app live." The repo has `web/` (Next.js) and `api/` (FastAPI + SQLAlchemy).
The local MCP server is connected.

1. Preview the plan:

   ```jsonc
   // deploy {"path": ".", "dry_run": true}
   {
     "status": "dry_run",
     "project": "shop",
     "plan": {
       "services": [
         { "name": "web", "framework": "nextjs", "kind": "web" },
         {
           "name": "api",
           "framework": "fastapi",
           "kind": "api",
           "port": 8000,
           "migrateCommand": "alembic upgrade head"
         }
       ],
       "data": ["postgres"],
       "missingSecrets": [],
       "assumptions": [
         {
           "service": "api",
           "message": "Assumed 'api' listens on port 8000 (uvicorn default)",
           "override": "port"
         }
       ]
     }
   }
   ```

2. The plan matches the repo (`DATABASE_URL` will be injected, the frontend gets the API URL
   through `NEXT_PUBLIC_API_URL`). Deploy:

   ```jsonc
   // deploy {"path": "."}
   {
     "status": "live",
     "urls": {
       "web": "https://shop.rivtor.app",
       "api": "https://shop-api.rivtor.app"
     },
     "verification": {
       "verdict": "working",
       "report_url": "https://rivtor.com/r/9b1f..."
     }
   }
   ```

3. Reply: both URLs, the verdict and the report link. Mention that `rivtor.json` now pins the
   project name.

## 2. Failed build: missing module

1. `deploy` returns:

   ```json
   {
     "status": "failed",
     "error": {
       "status": "failed",
       "stage": "release",
       "service": "api",
       "code": "missing_python_module",
       "cause": "Python module 'stripe' not found (imported in api/payments.py:3)",
       "file": "api/payments.py:3",
       "fix": "Add 'stripe' to requirements.txt (or pyproject.toml dependencies) of the 'api' service, then call deploy again",
       "retryable": true
     }
   }
   ```

2. Add `stripe` to `api/requirements.txt`. Nothing else changes.
3. `deploy` again; only `api` rebuilds. Result `live` with verdict `working`.
4. If the same code had come back, stop after the third attempt, read `logs` with the
   `deployment_id`, and explain what was tried.

## 3. needs_input: missing secret

1. `deploy` returns:

   ```json
   {
     "status": "needs_input",
     "error": {
       "status": "needs_input",
       "stage": "plan",
       "code": "missing_secrets",
       "cause": "The app reads secrets that are not set: STRIPE_SECRET_KEY, OPENAI_API_KEY",
       "fix": "Ask the user for STRIPE_SECRET_KEY, OPENAI_API_KEY, call env_set with them, then call deploy again.",
       "missing": [
         {
           "name": "STRIPE_SECRET_KEY",
           "service": "api",
           "usedIn": ["api/payments.py:3"]
         },
         {
           "name": "OPENAI_API_KEY",
           "service": "api",
           "usedIn": ["api/ai.py:8"]
         }
       ]
     }
   }
   ```

2. Ask once, for both: "The API needs STRIPE_SECRET_KEY (used in api/payments.py) and
   OPENAI_API_KEY (api/ai.py). Paste them here, or run
   `npx rivtor env set STRIPE_SECRET_KEY=... OPENAI_API_KEY=...` yourself."
3. Store them without echoing: `env_set {"vars": {"STRIPE_SECRET_KEY": "...", "OPENAI_API_KEY": "..."}}`
   (remote server: `set` instead of `vars`). The result lists key names only.
4. `deploy` again. Never repeat the values in the reply, and never write them to `.env` or
   `deploy.toml` in the repo.

## 4. Production issue: fix, verify, resolve

User: "Checkout is broken in production."

1. Read open issues:

   ```jsonc
   // issues {"project": "shop", "status": "open"}
   {
     "issues": [
       {
         "id": "5c0e...",
         "source": "production",
         "severity": "critical",
         "check": "api",
         "where": "POST /api/checkout",
         "cause": "KeyError: 'price_id'",
         "file": "api/routes/checkout.py:41",
         "fix": "...",
         "release": "rel_8f2...",
         "count": 37
       }
     ]
   }
   ```

2. If users are blocked and the fix is not quick, `rollback {"project": "shop"}` first (seconds,
   no rebuild), and say so.
3. Fix `api/routes/checkout.py:41`, then `deploy`. Check `verification.verdict`.
4. `verify {"project": "shop"}` to re-check the live app; confirm the route no longer fails.
5. `issue_resolve {"project": "shop", "id": "5c0e...", "status": "resolved"}`. It reopens
   automatically if the error recurs.
6. If verification reports `cors_blocked` with `auto_fixable: true`, ask the user before calling
   `verify_fix {"project": "shop", "consent": true, "issue_ids": ["..."]}`.
