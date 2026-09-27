# 07 — Goal Conditions (for `/goal`)
**Project:** Madar — Conversational layer for NPI ERP | **Package version:** 3.0 | **Date:** 2026-09-21

## Phase 0
- G-0-1 `docs/COPILOT_PHASE0_AR.md` exists with: Node version, `/api/docs-json` status, DTO shapes of the 5 flows, verdict on defects 14.1#1/#2 (reproduced/refuted with test names), provider policy quote+URL+date.
- G-0-2 `npm test -- numbering` passes a year-boundary case; `npm run test:int -- concurrency` green.
- G-0-3 `npm run test:int -- pr-approval-bypass` green (403 for non-step user and for requester).
- G-0-4 NPI suites green on `main` after merge; demo server redeployed; `/api/docs` returns 404 unless `EXPOSE_API_DOCS=1`.

## M1
- G-M1-1 `npm run copilot:build` exits 0 inside the workspace; NPI `npm run build` still green.
- G-M1-2 `npm run copilot:migrate` creates tables in `npi_copilot`; guard test rejects a URL ending in `/npi`.
- G-M1-3 `e2e/auth.spec.ts` green against local api; 6th failed login → 429; no password prefill.
- G-M1-4 `e2e/home.spec.ts` green: tiles equal NPI API counts for the seeded admin.
- G-M1-5 `npm test -w apps/copilot -- router agents memory llm pseudonymizer positions` green; HR guard → 0 llm rows.
- G-M1-6 smoke + `npm audit --audit-level=high` 0 + secret scan 0; tag `copilot-v0.1.0`.

## M2
- G-M2-1 6 packs validate; every permission key ∈ `/admin/permissions` response.
- G-M2-2 `onboarding-apply` tests green; second apply produces empty diff (idempotent).
- G-M2-3 AT-11 green; `onboarding_sessions` duration ≤ 30 min; gaps list non-empty and shown.
- G-M2-4 `e2e/settings.spec.ts` green; manual baselines saved per flow; tag `copilot-v0.2.0`.

## M3
- G-M3-1 `intake` and `consent` tests green; confidential file → 0 llm rows; image without consent → impossible (test).
- G-M3-2 `npm run eval:extract -- customer_contract` ≥ 90% fields on 6 docs.
- G-M3-3 `… -- pr po` ≥ 90%.
- G-M3-4 `… -- grn vendor_bill` ≥ 90%.
- G-M3-5 `e2e/preview.spec.ts` green (edit → re-preview; unconfirmed blocks approve).
- G-M3-6 `execute` + `invariants` + `e2e/no-bypass.spec.ts` green; AT-03 and AT-08 show ApprovalRequest opened in NPI.
- G-M3-7 `npm run eval:memory` ≥ 85%.
- G-M3-8 `handover` tests + e2e green.
- G-M3-9 `--grep @live-flows` green (AT-01..AT-05, AT-08, AT-09, AT-12); tag `copilot-v0.3.0`.

## M4
- G-M4-1 `npm run eval:pii` names ≥ 90%, structured ≥ 95%; `no-bypass-llm` grep guard = 0 including vision path.
- G-M4-2 `e2e/trust.spec.ts` green; every `imageSent=true` row has a consent id.
- G-M4-3 `cost` tests green; cap test triggers cap message.
- G-M4-4 `e2e/metrics.spec.ts` green; CSV header `assumption,metric,value,target,measured_at,details`, 6 assumption rows.
- G-M4-5 `npm run eval:extract` (all 20) ≥ 90% fields; `docs/COPILOT_EVAL_AR.md` written; `eval:behaviour` ≥ 18/20; tag `copilot-v0.4.0`.

## M5
- G-M5-1 `--project=mobile` green (AT-16 with camera mock).
- G-M5-2 `npm run perf -w apps/copilot` within budgets.
- G-M5-3 `docker compose -f docker-compose.prod.yml config -q` ok; copilot image builds, non-root, health 200.
- G-M5-4 `deploy.sh` dry-run shows copilot steps; `backup.sh` dry-run lists `npi_copilot` + docs; `bash -n` clean.
- G-M5-5 `--grep @live-demo` green on the demo server after `deploy.sh`; nightly reset verified next morning.
- G-M5-6 full regression green; PR merged; tag `copilot-v0.5.0`.

## Project complete
All G true; PROGRESS.md 46/46 with zero open decisions; owner recorded «ناجح» for Phase 0 and M1–M5 in `09`; a5 and a6 measured on the demo server with real employees for 14 days.
