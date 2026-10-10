# NPI Solar ERP — project context (read this first, it is short on purpose)

NOTION_PROJECT_NAME: NPI ERP — التحويل إلى وورك فلو متكامل   (PRJ-2, page 3d4ca444-c12c-815a-8295-c41ea9b972ac)

## What this repository is
Modular-monolith ERP for a Saudi solar company (`apps/api` NestJS + Prisma on PostgreSQL, `apps/web` Next.js,
`packages/*` shared). Since 2026-09 the active work is **Madar**, a conversational copilot layer in `apps/copilot`
built from the binding package in `spec/madar/00..11`, on branch `feat/copilot`. CRM phase 1 lives in the
`feature/crm-phase-1` branch (worktree `C:\dev\npi-erp-crm`).

## Where the truth is (read in this order, nothing else by default)
1. `PROGRESS.md` — live Madar state: task table, open decisions, deviations, pending live checks, owner summary (M4+).
2. `spec/madar/08-CLAUDE-CODE-KICKOFF.md` §E — binding rules; then only the `spec/madar` files the task names.
3. `docs/COPILOT_*_AR.md` — live Arabic reports for the owner.
4. Notion (project page above) — next step and open tasks; update at session end per `~/.claude/CLAUDE.md`.

## Do NOT read unless the task explicitly asks (archived, token-heavy, superseded)
- `docs/archive/**` — pre-Madar dossier, work orders, UX reviews, HTML reports (index in `docs/archive/README.md`).
- `docs/COPILOT_PROGRESS_ARCHIVE.md` — Phase 0/M1–M3 summaries and owner entries up to 2026-10-05, moved verbatim.
- `testsprite_tests/**`, `perf/**` — 2026-08 generated tests and k6 scripts; not part of any current gate.
- `apps/copilot/src/npi/openapi.json`, `apps/copilot/eval/*.json` — large fixtures; grep them, never open whole.
- `package-lock.json`, `.claude/worktrees/**`.

## Environments
- Local: api :4000, web :3000, copilot :3110 (`preview_start copilot`; port 3100 is **not** the copilot). Local DBs
  `npi_erp` and `npi_copilot`. Copilot tests: `npx jest` / `npx playwright test` inside `apps/copilot`, not `npm test`.
- Demo server (Hetzner, `root@204.168.182.109`, host `npi-erp-demo`, site `https://204-168-182-109.sslip.io`):
  Docker compose in `/opt/npi-erp` (**not** a git checkout; deployed from `deploy/pack.ps1` tarball). Image tag
  `20260927144531` = `main@4756ba6`. `main` is ahead only by deploy-script/comment fixes (PR #7, #8). The copilot
  (`feat/copilot`) is **not** deployed there yet (M5 tasks T-41…T-46).
- Deploy = `powershell -File deploy\pack.ps1` → `scp` → `ssh ... sh deploy/deploy.sh`; migrations run before the swap.

## Conventions
- Owner reads Arabic only: reports and owner docs in Arabic; code, comments and commits in English.
- One commit per task (`T-xx: summary`), then a `chore(copilot): PROGRESS.md …` commit. Never push to `main` directly;
  `main` changes go through a PR. Keep `feat/copilot` and `feature/crm-phase-1` pushed to `origin` after each task.
- Routing table and Notion protocol: `~/.claude/CLAUDE.md`. Testing skill: `.claude/skills/npi-erp-testing`.
