# Local environment for a test pass

Traps that look like product bugs when you hit them cold. Every one of these
has cost real time on this project at least once.

## Database

Portable PostgreSQL 16.6 lives at `C:\Users\eyadq\.npi-erp` — binaries in
`pgsql/`, data in `data/`, deliberately outside OneDrive (OneDrive's file
locking corrupts a running data directory). Port 5432, user `npi`, db `npi_erp`.

```bash
npm run db:start   # from the repo root
npm run db:stop
```

`db:start` can take longer than a shell tool's timeout on a cold start; that is
normal. Don't conclude it failed — check instead:

```bash
"C:\Users\eyadq\.npi-erp\pgsql\bin\pg_isready.exe" -h localhost -p 5432
```

## Ports

**Port 3000 belongs to a different project on this machine** (the NPI marketing
site). Run the ERP web server on 3001:

```bash
cd apps/web && npx next dev -p 3001
```

`main.ts` defaults its CORS allow-list to port 3000 only, so the API must be
started with the override or every browser call fails with an opaque CORS
error that reads like the API is down:

```bash
CORS_ORIGINS="http://localhost:3000,http://localhost:3001" npm run dev:api
```

API listens on 4000; routes are under `/api`.

## Seeded logins

| Email | Password | Role |
|---|---|---|
| `admin@npi.sa` | `Admin@123` | all permissions |
| `sales@npi.sa` | `Sales@123` | CRM + commercial |
| `accountant@npi.sa` | `Acc@12345` | finance + scm r/w |
| `pm@npi.sa` | `Pm@123456` | projects + scm r/w |
| `engineer@npi.sa` | `Eng@12345` | fsm + reads, **no finance** |

`engineer` is the most useful negative-case account: it is the role that
exposed the "403 rendered as an error banner" defect class.

Note the seed leaves a deactivated `keeper@npi.sa` behind from an earlier
lockout-guard test. That is expected, not a bug.

## Shell and encoding

- **Arabic in an inline `curl -d '{...}'` argument arrives mojibake-corrupted.**
  Windows argv encoding mangles it before curl ever sees it. Write the JSON
  payload to a UTF-8 file and use `curl --data-binary @file`. The bundled
  `api-smoke.mjs` sidesteps this entirely by using Node's `fetch`, which is one
  of the reasons it exists as a script rather than a pile of curl invocations.
- PowerShell's `Invoke-RestMethod` sends Arabic bodies as Latin-1 (`?????`).
  Use the Bash tool or Node, not PowerShell, for anything carrying Arabic.
- Heredocs with `<<'PY'` sometimes fail to parse in this Bash tool when the body
  is large or contains certain quoting. Write the script to a file in the
  scratchpad and run it instead of fighting the heredoc.

## Other known traps

- `prisma generate` fails with `EPERM` while any dev server holds the client.
  Stop node first: `Get-Process node | Stop-Process -Force`.
- `.next` hits `EBUSY` under OneDrive after many hot reloads. Kill the web
  server, delete `apps/web/.next`, restart.
- `tailwind.config.ts` changes need a **dev-server restart**; the config is
  cached and the change will appear to have no effect.
- The `@npi/shared` package is consumed from `dist/`. After editing permissions
  or enums there, `npm run build -w @npi/shared` or the API and web will keep
  reading the old values.

## Browser pane

The in-app pane on this machine often reports `innerHeight: 0` and returns an
empty accessibility tree, so `computer{action:"screenshot"}` and `read_page` are
unusable. Drive the DOM with `javascript_tool` instead — see SKILL.md §3. This
is a pane artefact; a `70vh` rule computing to `0px` here was once diagnosed as
a CSS bug when the authored rule was correct.

## What "green" means before a deploy

The deploy runbook expects all of these to pass first:

```bash
npm run typecheck
npm run lint
npm test
```

Plus this skill's API suite and UI sweep. The unit tests cover ZATCA hashing,
the permissions guard, numbering atomicity, the exception filter and stage
transitions; they do **not** touch the running database, which is exactly the
gap this skill fills.
