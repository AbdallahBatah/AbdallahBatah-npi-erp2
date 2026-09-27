# 05 — Implementation Plan (Delta on npi-erp)
**Project:** Madar — Conversational layer for NPI ERP | **Package version:** 3.0 | **Date:** 2026-09-21
**Size:** L — Phase 0 + 5 milestones, 46 tasks. Roles: DEV, DES, REV, TEST, SEC. ≤ 5 files per task; commit `T-xx: summary`; **[HIGHER MODEL]** per §7.2. All work in `C:\dev\npi-erp` on a branch `feat/copilot` from `main`, PR per milestone.

---
## Phase 0 — التدقيق والإصلاحان العاجلان (gate: owner «موافق» on the Arabic report)

**T-00a** | F-23 | REV | dossier §14.1, §9.5 | `docs/COPILOT_PHASE0_AR.md` | Verification of: Node version in use; `/api/docs-json` availability and DTOs of the 5 flows; defects 14.1#1 and #2 reproduced or refuted with a test; contract creation shape (milestones inline?); provider data-usage policy quoted with URL/date; test suites green on `main` | `npm test && npm run typecheck && npm run lint` on `main`, report file exists
**T-00b** | F-23 | DEV **[HIGHER MODEL — touches numbering core]** | `numbering.service.ts` | `apps/api/src/common/numbering.service.ts`, `apps/api/src/common/numbering.service.spec.ts`, migration `packages/db/prisma/migrations/0021_numbering_year/` (create sequence row on demand; document codes unchanged) | numbering works across a simulated year boundary; existing codes untouched; no duplicate under concurrency | `npm test -- numbering && npm run test:int -- concurrency`
**T-00c** | F-23 | DEV **[HIGHER MODEL — permissions]** | `requisitions.service.ts:258-278` | `apps/api/src/requisitions/requisitions.service.ts`, `…/requisitions.service.spec.ts`, `apps/api/test/pr-approval-bypass.int-spec.ts` | `APPROVE` on a PR with an open approval chain is rejected unless the caller is the current matrix step; requester cannot approve own PR | `npm test -- requisitions && npm run test:int -- pr-approval-bypass`
**T-00d** | SEC | SEC | dossier §10.2 | `apps/api/src/main.ts` (docs only when `EXPOSE_API_DOCS=1`), `apps/web/src/app/login/page.tsx` (prefill only when `NEXT_PUBLIC_DEMO_PREFILL=1`), `deploy/.env.example`, `deploy/docker-compose.demo-reset.yml` (sets flags for demo) | prod hides docs and prefill; demo keeps both | `npm run build && grep -n EXPOSE_API_DOCS apps/api/src/main.ts`
**Phase 0 gate:** Arabic report; PR `fix/phase0` merged to `main` and deployed to demo server via existing `deploy.sh`.

---
## M1 — الأساس (visible: employee logs into the copilot with NPI credentials, sees NPI-driven home tiles, chats with read-only tools)

**T-01** | F-01 | DEV | `02` §1 | `apps/copilot/package.json` (pinned same majors), `apps/copilot/next.config.js` (basePath `/copilot`), `apps/copilot/tailwind.config.ts` (import tokens from web), `apps/copilot/src/app/layout.tsx` (RTL, Plex Arabic), root `package.json` workspaces + scripts `copilot:dev/build/migrate` | builds inside workspace | `npm run copilot:build`
**T-02** | F-01 | DEV | `02` §3 | `apps/copilot/prisma/schema.prisma` (sessions, positions, assignments, handover, firm_config, onboarding_sessions), `apps/copilot/prisma/migrations/0001_init/`, `src/db.ts` (DB-name guard), `.env.example` | migrates into `npi_copilot`; guard refuses `/npi` | `npm run copilot:migrate && npm test -w apps/copilot -- db-guard`
**T-03** | F-01,F-12,F-17 | DEV | `02` §3 | `schema.prisma` (documents, intake_jobs, memory_facts + tsvector, conversations, messages, llm_audit, redaction_sessions, eval_runs, daily_usage), migration `0002_core/`, `src/memory/fts.ts` | full-text Arabic search works (`unaccent`/`pg_trgm`) | `npm test -w apps/copilot -- fts`
**T-04** | F-01 | DEV | `02` §4 | `src/npi/openapi.json` (fetched from `/api/docs-json` at build via script), `scripts/gen-npi-types.mjs`, `src/npi/types.ts` (generated), `src/npi/client.ts` (typed calls, timeout, Arabic error mapping), `src/npi/errors.ts` | typed client compiles; error map covers 401/403/404/409/422/500 | `npm run copilot:gen-types && npm test -w apps/copilot -- npi-client` (mocked)
**T-05** | F-01 | DEV | `02` §9 | `src/auth/session.ts` (AES-GCM), `src/auth/ratelimit.ts` (DB), `src/app/login/page.tsx`, `src/app/api/auth/route.ts`, `src/middleware.ts` | login via NPI; cookie; me() cached; logout | `npx playwright test e2e/auth.spec.ts` (against local api)
**T-06** | F-13 | DEV | `02` §3 positions | `src/positions/resolve.ts` (role+dept from `/auth/me` and `/admin/departments`), `src/positions/persona.ts`, `prompts/positions/*.md` (5), `tests/positions.spec.ts` | position resolved per user; persona loaded | `npm test -w apps/copilot -- positions`
**T-07** | F-21 | DES→DEV | `03` §1–4 | `src/components/ui/*` (Button, Card, Badge, States), `src/components/AppShell.tsx`, `src/i18n/ar.ts` (all strings), lint rule no-English-UI | shell RTL matches NPI look | `npm run lint -w apps/copilot`
**T-08** | F-02 | DEV | `02` §4 | `src/queries/home.ts` (inbox count, draft contracts, pending PRs, unmatched bills via NPI), `src/app/page.tsx`, `src/components/SummaryTile.tsx`, `apps/web/src/lib/nav.ts` (+ link «مساعد مَدار» → `/copilot`) | tiles from live NPI seed; four states | `npx playwright test e2e/home.spec.ts`
**T-09** | F-18,F-16 | DEV | 2.0 §4.2, ADR-04 | `src/llm/provider.ts`, `src/llm/providers/anthropic.ts`, `src/llm/client.ts` (RedactedRequest, tiers, cap, timeout), `config/pricing.json`, `src/privacy/pseudonymizer.ts` (port from 2.0 spec; dictionary sourced from NPI client caches) | branded gate; redact/rehydrate round trip | `npm test -w apps/copilot -- llm pseudonymizer`
**T-10** | F-03 | DEV | `02` §6 | `src/agents/router.ts`, `src/agents/hr-guard.ts`, `src/text/normalize.ts`, `prompts/router.md`, `tests/router.spec.ts` | 30 cases incl. 5 flows + HR guard | `npm test -w apps/copilot -- router`
**T-11** | F-03,F-12 | DEV **[HIGHER MODEL]** | `02` §6 | `src/agents/run.ts` (tool loop, overlays, audit), `src/agents/tools/read.ts` (get_customer, list_projects, list_open_tasks, get_po, search_items via NPI), `src/memory/{store,retrieve,extract-chat}.ts`, `src/app/api/chat/route.ts`, `prompts/assistant.md` | read-only chat end-to-end with memory notes | `npm test -w apps/copilot -- agents memory`
**T-12** | F-03 | DES→DEV | `03` §2 | `src/components/chat/{Chat,Message,Composer,WaitingIndicator}.tsx`, `src/components/MemoryNote.tsx` | chat UI four states | `npx playwright test e2e/chat-ui.spec.ts`
**T-13** | M1 gate | TEST+SEC | — | `apps/copilot/e2e/smoke.spec.ts`, `playwright.config.ts` (desktop + mobile) | smoke + audit + secret scan | `npx playwright test e2e/smoke.spec.ts && npm audit --audit-level=high`; tag `copilot-v0.1.0`

---
## M2 — التشكّل حسب النشاط (visible: admin runs the 7-question setup; NPI departments/roles/rules/items are configured through its API; chat reflects the profile)

**T-14** | F-14 | DEV | `02` §7, `03` §5 | `src/onboarding/profile.schema.ts`, `catalog/profiles/{epc,om_provider,ppa_operator}.json`, `tests/catalog.spec.ts` | packs validate; permissions ⊂ NPI catalog (fetched from `/admin/permissions`) | `npm test -w apps/copilot -- catalog`
**T-15** | F-14 | DEV | same | `catalog/profiles/{general_contracting,equipment_trading,engineering_consulting}.json`, `prompts/overlays/*.md` (6) | 6 packs validate | `npm test -w apps/copilot -- catalog`
**T-16** | F-14 | DEV **[HIGHER MODEL — admin API orchestration]** | `02` §7 | `src/onboarding/plan.ts` (pack + answers → NPI admin call plan + copilot config), `src/onboarding/apply.ts` (dry-run diff, apply in order, gaps), `src/onboarding/gaps.ts`, `tests/onboarding-apply.spec.ts` (mocked NPI) | diff correct; apply idempotent; gaps listed | `npm test -w apps/copilot -- onboarding-apply`
**T-17** | F-14 | DEV | `02` §7 | `src/onboarding/machine.ts` (7 steps), `src/onboarding/parse.ts` (economy model → schema), `prompts/setup-parse.md`, `src/app/api/setup/route.ts` | scripted answers → valid plan | `npm test -w apps/copilot -- onboarding-machine`
**T-18** | F-14 | DES→DEV | `03` | `src/app/setup/page.tsx`, `src/components/setup/{SetupStep,ProfileCard,DiffCard,PositionsStep}.tsx` | 7 screens + diff + apply | `npx playwright test e2e/setup.spec.ts` (mocked parse, live local NPI)
**T-19** | F-15 | DEV | — | `src/app/settings/page.tsx`, `src/components/settings/*.tsx`, `src/app/api/settings/route.ts` | module visibility, doc types, terminology, positions, manual baselines | `npx playwright test e2e/settings.spec.ts`
**T-20** | F-14 (a6) | TEST | AT-16 | `eval/setup-samples.json` (6), `e2e/setup-live.spec.ts` (@live), `src/metrics/onboarding.ts` | 6/6 profiles; ≤ 30 min; a6 computed | `npx playwright test --grep @live-setup`; tag `copilot-v0.2.0`

---
## M3 — الإدخال بالمحادثة (the core; visible: contract from PDF, PR from a sentence, vendor bill from a photo — all executed in NPI)

**T-21** | F-04 | DEV | `02` §5.1–5.3 | `src/intake/upload.ts` (magic bytes, sha256, storage), `src/intake/pdf.ts` (pdf-parse, scanned detection, rasterize), `src/intake/sensitivity.ts`, `src/app/api/documents/route.ts`, `tests/intake.spec.ts` | kinds detected; confidential refused | `npm test -w apps/copilot -- intake`
**T-22** | F-04,F-16 | DEV | ADR-27 | `src/intake/consent.ts`, `src/components/ConsentCard.tsx`, `src/llm/vision.ts` (image/PDF blocks per verified docs), `src/audit/log.ts` (imageSent + consentEventId) | no image leaves without consent event | `npm test -w apps/copilot -- consent`
**T-23** | F-05 | DEV **[HIGHER MODEL — extraction + NPI DTO mapping]** | `02` §5.4–5.6 | `src/extract/schemas/customer_contract.ts` (zod mirroring NPI DTO), `prompts/extract/customer_contract.md`, `src/extract/run.ts` (generic: prompt → JSON → validate → confidence), `src/extract/resolve.ts` (customer/project/PO/item resolution), `tests/extract-contract.spec.ts` | 6 eval contracts ≥ 90% fields | `npm run eval:extract -- customer_contract`
**T-24** | F-06,F-07 | DEV | same | `src/extract/schemas/{pr,po}.ts`, `prompts/extract/{pr,po}.md`, `tests/extract-pr-po.spec.ts` | PR from sentence + PO from quote ≥ 90% | `npm run eval:extract -- pr po`
**T-25** | F-08,F-09 | DEV | same | `src/extract/schemas/{grn,vendor_bill}.ts`, `prompts/extract/{grn,vendor_bill}.md`, `tests/extract-grn-bill.spec.ts` | GRN from photo, bill linked to PO/GRN ≥ 90% | `npm run eval:extract -- grn vendor_bill`
**T-26** | F-10 | DES→DEV | `03` §2 | `src/components/PreviewCard.tsx`, `src/components/ExecutionCard.tsx`, `src/intake/edit.ts` (text edit → re-parse), `src/app/documents/[id]/page.tsx` | confirmed/unconfirmed, inline edit, will-execute list | `npx playwright test e2e/preview.spec.ts`
**T-27** | F-11 | DEV **[HIGHER MODEL — financial writes]** | `02` §5.8, ADR-29 | `src/execute/plan.ts` (flow → ordered NPI calls), `src/execute/run.ts` (stop-on-failure, ids, attach doc), `src/execute/flows/{customer_contract,pr,po,grn,vendor_bill}.ts`, `tests/execute.spec.ts` (mocked NPI) | correct call order; partial failure reported; no retry of writes | `npm test -w apps/copilot -- execute`
**T-28** | F-11 | TEST | AT-13, AT-14 | `apps/copilot/e2e/no-bypass.spec.ts` (staff cannot make copilot approve; PR created via chat lands in matrix; 403 surfaced), `tests/invariants.spec.ts` (no `@prisma/client` import pointing at npi; no admin token env) | invariants hold | `npm test -w apps/copilot -- invariants && npx playwright test e2e/no-bypass.spec.ts`
**T-29** | F-12 | DEV | `02` §8 | `src/memory/extract-npi.ts` (terms from contracts, vendor lead times, recurring items, active projects), `eval/memory-facts.json` (50 from demo seed), `eval/memory-questions.json` (50), `scripts/eval-memory.ts` | ≥ 85% | `npm run eval:memory`
**T-30** | F-13 | DEV | ADR-18 | `src/positions/{reassign,handover}.ts` (open NPI inbox tasks + position facts → advanced tier), `prompts/handover.md`, `src/app/handover/page.tsx`, `src/components/HandoverDoc.tsx` | handover doc; predecessor chats admin-only; guidance 7 days | `npm test -w apps/copilot -- handover && npx playwright test e2e/handover.spec.ts`
**T-31** | F-05…F-11 | TEST | `06` AT-01…AT-06 | `e2e/scenarios.spec.ts` (@live against local NPI + real model), `e2e/fixtures/{reset,docs}.ts` | live scenarios pass | `npx playwright test --grep @live-flows`; tag `copilot-v0.3.0`

---
## M4 — الحوكمة والقياس

**T-32** | F-16 | TEST→DEV | 2.0 §6 eval | `eval/pii-sentences.json` (100, NPI vocabulary), `scripts/eval-pii.ts`, `tests/no-bypass-llm.spec.ts` (grep guard incl. vision path) | names ≥ 90%, structured ≥ 95% | `npm run eval:pii && npm test -w apps/copilot -- no-bypass-llm`
**T-33** | F-17 | DEV | `02` §8 | `src/app/trust/page.tsx`, `src/components/AuditTable.tsx`, `src/app/api/audit/route.ts` | every llm event incl. images with consent id | `npx playwright test e2e/trust.spec.ts`
**T-34** | F-18 | DEV | — | `src/audit/cost.ts`, `src/queries/usage.ts`, `tests/cost.spec.ts` | per document/flow/day/tier; cap | `npm test -w apps/copilot -- cost`
**T-35** | F-19,F-20 | DES→DEV | `01` §7 | `src/app/metrics/page.tsx`, `src/components/MetricCard.tsx`, `src/metrics/compute.ts` (a1–a6 incl. field accuracy and time ratio vs manual baseline), `src/app/api/metrics/export/route.ts` | 6 cards + CSV | `npx playwright test e2e/metrics.spec.ts`
**T-36** | F-20 | TEST | `03` §6 | `eval/extract/*` (20 docs + expected.json), `scripts/eval-extract.ts` (already used), `docs/COPILOT_EVAL_AR.md` | full set ≥ 90% fields; report in Arabic | `npm run eval:extract`
**T-37** | M4 gate | REV+SEC | `06` §2–3 | `eval/behaviour.json` (20), `scripts/eval-behaviour.ts` | ≥ 18/20; OWASP; audit; secrets | `npm run eval:behaviour && npm run scan:secrets`; tag `copilot-v0.4.0`

---
## M5 — الجوال والنشر

**T-38** | F-21 | DES→DEV | `03` | `src/components/chat/{CameraButton,MicButton}.tsx`, `src/voice/speech.ts`, mobile CSS in `AppShell.tsx`/`PreviewCard.tsx`, `e2e/mobile.spec.ts` | camera capture on mobile; 390 px no horizontal scroll | `npx playwright test --project=mobile`
**T-39** | NFR | DEV | `02` §10 | `scripts/perf.mjs`, `next.config.js` budgets, indexes migration `0003_indexes/` | LCP/INP/CLS/JS budgets | `npm run perf -w apps/copilot`
**T-40** | F-22 | DEV | `02` §11 | `apps/copilot/Dockerfile` (multi-stage, non-root, healthcheck), `docker-compose.prod.yml` (+ `copilot` service, `copilot_docs` volume, env), `deploy/Caddyfile` (`handle_path /copilot*`), `deploy/.env.example` | compose config valid; health 200 | `docker compose -f docker-compose.prod.yml config -q && docker build -f apps/copilot/Dockerfile .`
**T-41** | F-22 | DEV | `02` §11 | `deploy/deploy.sh` (build copilot, migrate `npi_copilot`, rolling restart — extend only), `deploy/backup.sh` (+ pg_dump npi_copilot + docs tar + restore check), `deploy/docker-compose.demo-reset.yml` (+ reset copilot), `deploy/MIGRATIONS_AR.md` (+ copilot note) | rolling deploy with rollback covers copilot | `bash -n deploy/deploy.sh deploy/backup.sh && npm test -w apps/copilot -- deploy-scripts` (shell syntax + dry-run flags)
**T-42** | F-22 | DEV→REV | `00` §4 | `docs/COPILOT_RUN_AR.md` (Arabic: local run, deploy, backup/restore, consent policy, what to do when NPI rejects), `docs/COPILOT_CHANGELOG.md` | Arabic-only outside code spans | `npm test -w apps/copilot -- docs`
**T-43** | F-22 | TEST | AT-19 | `e2e/deploy.spec.ts` (against demo server URL from env, @live-demo) | `/copilot` healthy behind Caddy; login works; nightly reset keeps it working | `npx playwright test --grep @live-demo`
**T-44** | SEC | SEC | `02` §10 | `src/security/headers.ts`, `tests/security.spec.ts` (CSP, no admin token, DB guard, upload magic bytes) | pass | `npm test -w apps/copilot -- security`
**T-45** | all | REV+TEST | — | full regression | all suites + evals green | `npm test && npm run test:int && npx playwright test && npm run eval:extract && npm run eval:pii && npm run eval:memory`
**T-46** | release | DEV | — | PR `feat/copilot` → `main`, tag `copilot-v0.5.0`, deploy to demo | merged and deployed | `git tag -l copilot-v0.5.0`

---
## Traceability (F → T)
F-01:T-01,T-02,T-04,T-05 | F-02:T-08 | F-03:T-10,T-11,T-12 | F-04:T-21,T-22 | F-05:T-23 | F-06:T-24 | F-07:T-24 | F-08:T-25 | F-09:T-25 | F-10:T-26 | F-11:T-27,T-28 | F-12:T-03,T-11,T-29 | F-13:T-06,T-30 | F-14:T-14,T-15,T-16,T-17,T-18,T-20 | F-15:T-19 | F-16:T-09,T-22,T-32 | F-17:T-22,T-33 | F-18:T-09,T-34 | F-19:T-35 | F-20:T-36 | F-21:T-07,T-38 | F-22:T-40,T-41,T-42,T-43 | F-23:T-00a,T-00b,T-00c,T-00d
