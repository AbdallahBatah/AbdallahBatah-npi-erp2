# 08 — Claude Code Kickoff (existing project: npi-erp)
**Project:** Madar — Conversational layer for NPI ERP | **Package version:** 3.0 | **Date:** 2026-09-21
Owner pastes A, B, C, D verbatim. Section E is binding for the implementer.

---
## A. PRE-FLIGHT (paste first, inside `C:\dev\npi-erp`)
```
You are preparing the existing "npi-erp" repository for the "Madar copilot" package. Do exactly this and report in Arabic only:
1. Confirm the working directory is a Git repo on branch main with a clean tree (`git status`), and that its path is NOT under OneDrive. If dirty or on OneDrive, explain in Arabic and stop.
2. Run: node -v ; npm -v ; git --version ; docker --version ; docker compose version. Record the Node version NPI uses (check .nvmrc, package.json engines, CI workflow, apps/*/Dockerfile). Report if it is below 20.
3. Check ./spec/madar/ contains the 12 package files (00..11). List missing ones and stop if any.
4. Check .env (local) contains a non-empty ANTHROPIC_API_KEY line. Never print its value. If missing, explain where to put it and stop.
5. Start Postgres with `npm run docker:up`, run `npm ci`, then `npm run typecheck && npm run lint && npm test`. Report pass/fail counts.
6. Check that http://localhost:4000/api/docs-json responds when the API runs (`npm run dev` for api per .claude/launch.json, then curl). Report whether the OpenAPI JSON is available.
7. Report an Arabic table (✅/❌) and, if all required checks pass: «المستودع جاهز، الصق أمر المرحلة صفر».
```

---
## B. PHASE 0 (paste after pre-flight passes)
```
You are implementing Phase 0 of the "Madar copilot" package in ./spec/madar/. Read spec/madar/00..11 completely first. Then, on a new branch fix/phase0 from main, execute tasks T-00a, T-00b, T-00c, T-00d exactly as written in spec/madar/05, in order, one commit per task (`T-00x: summary`). Rules in spec/madar/08 section E are binding.
For T-00a: verify each «unverified» item listed in spec/madar/02 §0 and §1 by running code or tests or reading official documentation; write docs/COPILOT_PHASE0_AR.md in Arabic with evidence (file:line, test name, URL+date). Fetch and quote Anthropic's current API data-usage policy with URL and date. Do not guess; mark anything you could not verify as «غير متحقق».
For T-00b and T-00c: these touch financial numbering and approval permissions — if the environment can delegate to a stronger model, do so; otherwise stop and tell the owner in Arabic: «المهمة T-00b تحتاج نموذجاً أعلى؛ بدّل النموذج ثم اكتب "تابع"». Every fix needs a regression test that fails before and passes after. NPI's full unit and integration suites must stay green.
When done: open a PR fix/phase0 → main, run the full suites, and report in Arabic: what was verified, what was fixed with test names, what could not be verified, and «افتح الملف 09 ونفّذ سيناريو المرحلة صفر». Wait for «موافق» before merging.
```

---
## C. FIRST RUN (paste after Phase 0 is merged)
```
You are the implementer of the "Madar copilot" layer on the existing npi-erp repository. The package is in ./spec/madar/. The owner reads Arabic only; reports to the owner in Arabic; code, comments, commits in English.
STEP 1 — READ spec/madar/00..11 completely and docs/COPILOT_PHASE0_AR.md.
STEP 2 — INVENTORY: project and user-level agents, skills, commands (.claude/*, ~/.claude/*), MCP servers, CLAUDE.md, the npi-erp-testing skill, TestSprite, /goal. Write to PROGRESS.md.
STEP 3 — ROLE MAPPING per spec/madar/05 roles; substitutes per section E.2.
STEP 4 — PLAN: show in Arabic the inventory, mapping, 5 milestones with task counts, [HIGHER MODEL] tasks (T-11, T-16, T-23, T-27) and how you will handle them, and the exact versions to pin (same majors as the repo; `npm view` for new packages). Ask exactly «اكتب "موافق" للبدء». Wait.
STEP 5 — EXECUTE on branch feat/copilot from main: copy spec/madar/11-PROGRESS.md to ./PROGRESS.md; tasks T-01…T-46 in order; read only the files named in each task; run the task's Verify until green; commit `T-xx: summary`; update PROGRESS.md.
STEP 6 — MILESTONE GATE: run the milestone verify commands, NPI's own suites (`npm test`, `npm run test:int`), the adversarial review (spec/madar/06 §1–3, OWASP), `npm audit --audit-level=high`, secret scan; check every G in spec/madar/07; write the summary; clear context; Arabic report with P1/P2/P3 decisions and «افتح الملف 09 ونفّذ سيناريو المرحلة X». Wait for «موافق».
STEP 7 — DOCUMENTATION BEFORE USE: official docs or node_modules types before any library API; for Anthropic PDF/image inputs and for every NPI endpoint use the generated OpenAPI types; never invent DTO fields.
STEP 8 — STOP ON AMBIGUITY: write the question in PROGRESS.md → Decisions needed, report in Arabic with a recommended default. Do not guess.
STEP 9 — COST AND SECRETS: no paid service; no secrets in code; keys from env only.
STEP 10 — Section E of spec/madar/08 is binding.
```

---
## D. RESUME (any new session)
```
Resume the "Madar copilot" implementation in npi-erp. Read ./PROGRESS.md, then spec/madar/00..11. Re-run the inventory (STEP 2). Confirm branch feat/copilot and a clean tree; otherwise report in Arabic and wait. Continue from the first task not marked done, following spec/madar/08 section E.
```

---
## E. IMPLEMENTER RULES (binding)
### E.1 Precedence
`CLAUDE.md` (project, user) for conventions and safety → this package for product/technical decisions → **NPI's existing code and OpenAPI for API behaviour** (the copilot adapts to NPI, never the reverse, except T-00 fixes) → official library docs for library APIs. Conflicts reported in Arabic before acting; logged in PROGRESS.md → Deviations.
### E.2 Substitutes for absent roles
REV → self-review against `06` §1–3 + OWASP written in PROGRESS.md; TEST → Jest + Playwright per task, and the repo's `npi-erp-testing` skill if present; SEC → `npm audit` + secret scan + OWASP; DES → literal `03`.
### E.3 Do-not-touch (from `02` §13)
No changes to `packages/db` schema, NPI migrations (except T-00b), `posting.service.ts`, approval matrix, workflow engine, existing endpoint contracts, `apps/web` (except the single nav link in T-08), `deploy.sh` semantics (extend only). Any need to change them → stop and report.
### E.4 Safety limits
No destructive commands; no `push --force`; no drop/reset of `npi`; no deletion of migrations; no direct SQL against `npi` from copilot code or scripts; nothing outside the repo. NPI seed and demo data only — never real customer data in the repo or tests.
### E.5 Nothing unrequested; decisions fixed
No features/refactors/upgrades outside the task; suggestions → PROGRESS.md. `04` decisions are not changed; if unapplicable, stop and report.
### E.6 Higher model
T-00b, T-00c, T-11, T-16, T-23, T-27: delegate to a stronger model if the environment allows; otherwise stop and tell the owner «المهمة T-xx تحتاج نموذجاً أعلى؛ بدّل النموذج ثم اكتب "تابع"».
### E.7 Owner's direct requests
Bug fix inside a task: do and log. Anything touching F-xx or ADR-xx: refer to the engineer.
### E.8 Language
No Latin text visible in the copilot UI (except codes like PRJ-00012, INV numbers, CSV). Arabic for owner docs (`docs/COPILOT_*_AR.md`).
### E.9 Integrity rules (carried from NPI's own work order — keep verbatim)
Never record a test as passed that you did not run. Never alter a scenario to match the output. On any defect with financial effect, stop and report before fixing. Every milestone report states what was NOT done and why.
### E.10 Scope guards specific to 3.0
- The copilot writes to NPI only through `src/npi/client.ts` with the user's JWT. No admin token, no `npi` DATABASE_URL, no Prisma client for `npi` in `apps/copilot`.
- Exactly five flows. No delete tools. No approval tools (approval happens in NPI's inbox only).
- Images/scans reach the model only after a consent event; text always after redaction.
- The catalog applies only what NPI's admin API accepts; gaps are listed, never worked around.
- `MADAR_PROVIDER` accepts only `anthropic`.
