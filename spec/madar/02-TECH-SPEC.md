# 02 — Technical Specification (Delta on npi-erp)
**Project:** Madar — Conversational layer for NPI ERP | **Package version:** 3.0 | **Date:** 2026-09-21 | **Path:** existing project

## 0. Current state (from PROJECT_DOSSIER_AR.md, 2026-09-19, `main@1dc0504`) — what this package builds on
| Item | State | Consequence for this package |
|---|---|---|
| Repo | npm workspaces: `apps/api` (NestJS 10, Prisma 5.22, PostgreSQL 16), `apps/web` (Next 14.2, React 18, Tailwind 3), `packages/db`, `packages/shared`, `deploy/` (Compose + Caddy, rolling deploy, backup.sh) | Add `apps/copilot`; never modify `packages/db` schema or `apps/api` business logic except T-00 fixes |
| API | ~149 endpoints under `/api`, JWT Bearer (12 h), fail-closed `PermissionsGuard`, row-level tenancy by `organizationId`, OpenAPI at `/api/docs` | Copilot is a **client** of this API, acting as the logged-in user |
| Flows under workflow engine | PR, PO, GRN, vendor bill (`POST …/:id/actions`) | The four procurement flows execute via engine transitions |
| Approval matrix | `ApprovalRule*`, SoD controls, delegation | Untouched; runs after copilot input |
| Known defects relevant here | numbering breaks on 1 Jan (14.1#1); PR approve bypasses matrix (14.1#2); `/api/docs` public; login prefilled | T-00 fixes #1, #2; #3/#4 gated in deploy env |
| Frontend | client-only pages, JWT in localStorage | Copilot has its own server-side session; no reuse of `apps/web` code |
| Deploy | `docker-compose.prod.yml`: postgres, api, web, caddy; `deploy.sh` rolling | Add `copilot` service + Caddy route `/copilot*` |
| Seed/demo | `seed.ts` + `scripts/seed-demo.js` (51 scenarios), nightly reset 03:00 on demo server | Used as test data; copilot seed adds only its own tables |

**Unverified (dossier marks «ق»)** and must be confirmed in Phase 0: defects 14.1#1 and #2, exact Node version in use, DTO shapes of the 5 flows (from `/api/docs`), whether `POST /api/contracts` accepts milestones inline or requires separate calls.

## 1. Verified technology baseline
| Item | Decision | Verified | Confidence | Source |
|---|---|---|---|---|
| Node | the version NPI runs on (Phase 0 reads `.nvmrc`/CI/Dockerfile); if < 20, copilot container pins `node:24-alpine` independently | 2026-09-21 | Confirmed (Node 24 LTS active until 2026-10-20) | nodejs/Release |
| Copilot framework | **Next.js 14.2** (same major as `apps/web` to avoid workspace hoisting conflicts) + TypeScript + Tailwind 3 (same as web) | 2026-09-21 | Confirmed (from dossier) | dossier §4.2 |
| Copilot DB | **PostgreSQL 16 (existing server), separate database `npi_copilot`, Prisma 5.22** (same version), own `apps/copilot/prisma/schema.prisma` + migrations | 2026-09-21 | Confirmed | dossier |
| LLM | `@anthropic-ai/sdk`; economy `claude-haiku-4-5-20251001`, advanced `claude-sonnet-5`; **PDF and image inputs** via base64 `document`/`image` content blocks | 2026-09-21 | Model IDs confirmed; PDF/image input: Likely — **verify request shape and page limits in official docs before T-16** | platform.claude.com/docs |
| Provider data usage | API inputs not used for training by default (Anthropic commercial terms) | 2026-09-21 | **Unverified — Phase 0 must fetch and quote the current policy; result recorded in `10` §8 and shown in the image-consent card** | anthropic.com legal |
| PDF text extraction | `pdf-parse` (MIT) locally; fallback to image path if < 50 chars extracted (scanned PDF) | — | Likely | pin via npm view |
| OpenAPI types | `openapi-typescript` generating `apps/copilot/src/npi/types.ts` from `/api/docs-json` | — | Likely; verify NPI exposes JSON spec (Swagger default `/api/docs-json`) | Phase 0 |
| Tests | Jest (same as repo) for unit; Playwright for e2e in `apps/copilot/e2e` | — | Likely | pin |
| Pricing | Haiku 4.5 $1/$5; Sonnet 5 $2/$10 per MTok | 2026-09-20 | Haiku confirmed; Sonnet likely — re-verify, date in `config/pricing.json` | official pricing page |

Version pinning rule: exact versions via `npm view` at T-01, recorded in PROGRESS.md.

## 2. Architecture
```
Browser ─► apps/copilot (Next.js, server session)  ─► apps/api (NestJS) as the user ─► PostgreSQL (npi)
               │                                     ▲ Bearer <user JWT>, never admin
               ├─ npi/client.ts (typed from OpenAPI) ─┘
               ├─ intake/ (pdf-parse, image handling, consent)
               ├─ extract/ (document → NPI DTO, per flow, confidence)
               ├─ agents/ (router, position overlay, tools, HR guard)
               ├─ memory/ (facts from NPI data + chat, scopes)
               ├─ privacy/ (pseudonymizer — only gate to llm/)
               ├─ llm/ (ModelProvider: anthropic only)
               ├─ audit/ (llm audit + cost)
               └─ prisma (db: npi_copilot)
Caddy: /copilot* → copilot:3100 ; /api* → api:4000 ; /* → web:3000
```
**Invariants:** (I1) copilot has no `DATABASE_URL` to the `npi` database — only `npi_copilot`; a startup check refuses a URL whose database name is not `npi_copilot`. (I2) every NPI write goes through `npi/client.ts` with the caller's JWT; there is no service/admin token in copilot env. (I3) `RedactedRequest` branded type gate as in v2 (ADR-04). (I4) any image sent to the model has a `consent_event_id` in `llm_audit`.

## 3. Copilot data model (Prisma, database `npi_copilot`)
| Table | Key columns |
|---|---|
| `copilot_sessions` | id, npiUserId, npiOrgId, roleKey, departmentId, tokenEncrypted (AES-256-GCM with `COPILOT_SESSION_KEY`), expiresAt |
| `positions` | npiOrgId, roleKey, departmentId (nullable), titleAr, personaAr — unique (org, role, dept) |
| `position_assignments` | positionId, npiUserId, startedAt, endedAt, handoverDocId |
| `handover_docs` | positionId, fromUserId, toUserId, bodyJson, bodyAr |
| `firm_config` | npiOrgId, profileKey, visibleModulesJson, acceptedDocTypesJson, terminologyJson, setupCompletedAt, npiApiGapsJson |
| `onboarding_sessions` | startedAt, completedAt, stepsJson, profileChosen |
| `documents` | id, npiUserId, fileName, mime, sha256, storagePath (volume), kind (`pdf_text`/`pdf_scanned`/`image`), sensitivityFlag, consentEventId, extractedTextRedactedRef |
| `intake_jobs` | documentId (nullable), conversationId, flowType (`customer_contract`/`pr`/`po`/`grn`/`vendor_bill`), status (`extracting`/`preview`/`approved`/`executing`/`done`/`failed`/`cancelled`), extractedJson (fields + confidence), previewJson, executionLogJson (NPI calls, ids, codes), npiEntityRefs, error |
| `memory_facts` / `memory_fts`(pg `tsvector` + `pg_trgm`) | scope, positionId, entityType (`customer`/`vendor`/`project`/`item`/`position`), npiEntityId, factAr, valueJson, sourceType (`npi`/`chat`), confidence, useCount |
| `conversations`, `messages` | as v2 (+ `intakeJobId`) |
| `llm_audit` | ts, npiUserId, event, modelTier, modelId, tokensIn/Out, costUsdMicro, outboundRedactedText, imageSent (bool), consentEventId, latencyMs, error |
| `redaction_sessions`, `eval_runs`, `daily_usage` | as v2 |
Migrations under `apps/copilot/prisma/migrations`; `npm run copilot:migrate`.

## 4. NPI client (`src/npi/`)
- Types generated from OpenAPI (Phase 0 confirms `/api/docs-json`). Thin functions per endpoint used: `login`, `me`, `listCustomers`, `createCustomer`, `createContract`, `addMilestone` (or inline), `listProjects`, `listWbs`, `createRequisition`, `requisitionAction`, `listPurchaseOrders`, `createPurchaseOrder`, `poAction`, `createReceipt`, `receiptAction`, `createBill`, `billAction`, `attachFile`, `inboxTasks`, admin: `listDepartments/createDepartment`, `listRoles/updateRolePermissions`, `listApprovalRules/createApprovalRule`, `listItems/createItem`, `orgSettings`.
- Every call: Bearer from session, 10 s timeout, errors mapped to Arabic via NPI error codes (no regex translation); 403/404/409 surfaced verbatim in the card («NPI رفض: …»).
- **Read caching:** customers/vendors/projects/items lists cached 5 min per org for entity resolution and pseudonymization dictionary.

## 5. Intake & extraction
1. Upload (≤ 10 MB; pdf/jpg/png/heic→converted): sha256 dedupe; sensitivity check (filename or first 2 000 chars contain «سري|سرّي|confidential») → refuse with `intake.refused_confidential`.
2. PDF → `pdf-parse`; ≥ 50 chars → `pdf_text`: text → pseudonymize → model. Else `pdf_scanned` → rasterize pages 1–5 (pdf.js) → image path.
3. Image path: show `ConsentCard` («سيُرسل هذا المستند كصورة إلى مزوّد النماذج (Anthropic). سياسة المزوّد: {policy_line}. اعتمد الإرسال / ألغِ») → on approve, `consent_event` + `llm_audit.imageSent=true` → advanced tier with vision.
4. Flow detection: user text + document → economy classifier → one of 5 flows or «لم أفهم؛ اختر»; user can force with chips.
5. Extraction prompt per flow (`prompts/extract/<flow>.md`) returns strict JSON matching a zod schema mirroring the NPI DTO plus `confidence` per field and `evidence` (quoted span or page). Server validates; unknown fields dropped; critical fields (VAT number `3\d{13}3`, totals, dates) validated and forced «غير مؤكد» if invalid.
6. Entity resolution (BR-09): customer/vendor by VAT then normalized name; project by code/name; PO by code; items by name similarity (≥ 0.85 trigram) else «صنف جديد؟».
7. Preview card: grouped fields, confirmed vs unconfirmed, editable inline (text edit → re-parse), and «ما سيُنفَّذ» list of NPI calls in order.
8. Execution (on approve): ordered NPI calls in one `intake_job` with compensation notes (no cross-call transaction exists; if call k fails, stop, report ids created so far, never retry writes automatically); attach the document to the created entity; store `npiEntityRefs`; memory extraction; audit.
9. Time metric: `intake_jobs.createdAt → approvedAt` per flow; manual baseline entered once in `/settings` per flow (owner measures with a stopwatch on the NPI screen).

## 6. Agents, routing, tools
- Router: HR guard → rules (Arabic keywords per flow + «عقد/طلب شراء/أمر شراء/استلام/فاتورة مورد») → economy classifier fallback. Module visibility from `firm_config.visibleModulesJson`.
- Position overlay: persona by (role, department) from catalog or setup; memory scope `position`.
- Tools (read via NPI): `get_customer`, `list_projects`, `list_open_tasks`, `get_po`, `search_items`, `memory_search`; write proposals only via intake jobs (never direct).
- Tier: extraction & handover = advanced; classification, lookups, memory extraction = economy. Vision always advanced.

## 7. Onboarding & profile catalog (F-14)
Catalog `catalog/profiles/{epc,om_provider,ppa_operator,general_contracting,equipment_trading,engineering_consulting}.json`, schema: `key, titleAr, revenueLines[], visibleModules[] ⊂ {crm, commercial, projects, procurement, fsm, finance, ppa, telemetry}, acceptedDocTypes[], terminology{}, defaultDepartments[], rolePermissionSets{roleKey: permissions[]} (subset of NPI's 35 keys), approvalRuleDefaults[] {docType, minAmount, steps[]}, itemTemplates[], positions[] {roleKey, departmentCode, titleAr, personaAr}`.
Setup flow (admin only): Q1 النشاط وخطوط الإيراد → Q2 الأقسام والمناصب وشاغلوها (existing NPI users mapped) → Q3 سقوف الاعتماد (يقترح الافتراضي) → Q4 المستندات المتداولة → Q5 الأصناف الشائعة → Q6 المصطلحات → Q7 ملخص «هذا ما سأضبطه في NPI وما سأضبطه في المحادثة» → apply: NPI admin API (departments, role permissions, approval rules, items, org settings) with dry-run diff shown first; copilot config written. Anything NPI's API cannot set is listed under `npiApiGapsJson` and shown («لا تتيحه واجهة NPI حالياً»). Re-runnable per step from `/settings`.

## 8. Memory, pseudonymization, audit, cost, metrics
As in package 2.0 §5–§8 with these deltas: dictionary from NPI customers/vendors/users/projects; NPI-derived facts (payment terms from contracts, vendor lead time from PO→GRN dates, recurring items from POs, active projects per user); `llm_audit.imageSent` shown in `/trust` with the consent id; metrics a1–a6; CSV export `copilot-metrics.csv` (6 assumption rows + details).

## 9. Auth
Login form → `POST /api/auth/login` → JWT stored encrypted server-side; cookie `copilot_session` httpOnly/secure/sameSite=lax; every request re-validates via `GET /api/auth/me` (cached 60 s). Logout deletes the session. Rate limit 5/15 min (DB). No password prefill anywhere.

## 10. NFRs (numeric)
Same as 2.0 §11 plus: extraction ≤ 25 s for a 5-page PDF (p90), ≤ 40 s for 5 images; NPI call timeout 10 s; document storage volume `copilot_docs`; retention of documents = retention of the NPI entity (never auto-deleted). Security: OWASP list; no `DATABASE_URL` to `npi`; CSP; uploads validated by magic bytes; per-user daily token cap `COPILOT_DAILY_TOKEN_CAP=600000`.

## 11. Environments & deployment
| | Local | Demo server (Hetzner) |
|---|---|---|
| Start | `npm run copilot:dev` (api + copilot; Postgres via `npm run docker:up`) | `pack.ps1` → `deploy.sh` (extended: builds copilot image, migrates `npi_copilot`, rolling restart) |
| URL | http://localhost:3100 | https://<SITE_ADDRESS>/copilot |
| DB | `npi_copilot` on local Postgres | `npi_copilot` on prod Postgres container |
| Docs volume | `./data/copilot_docs` | `copilot_docs` |
`deploy/backup.sh` extended: `pg_dump npi_copilot` + tar of `copilot_docs`, same rotation and restore check. Nightly demo reset (03:00) also resets `npi_copilot` (extend `docker-compose.demo-reset.yml`). Rollback: `deploy.sh --rollback` covers copilot image; copilot migrations follow NPI's two-release expand/contract rule.

## 12. Env (`apps/copilot/.env.example`)
```
COPILOT_DATABASE_URL=postgresql://…/npi_copilot   # must end with /npi_copilot
NPI_API_BASE=http://api:4000/api                  # local: http://localhost:4000/api
ANTHROPIC_API_KEY=
MADAR_PROVIDER=anthropic
COPILOT_MODEL_ECONOMY=claude-haiku-4-5-20251001
COPILOT_MODEL_ADVANCED=claude-sonnet-5
COPILOT_SESSION_KEY=            # 32 bytes hex, generated at first run
COPILOT_DOCS_DIR=/data/copilot_docs
COPILOT_DAILY_TOKEN_CAP=600000
COPILOT_PORT=3100
```

## 13. «Do not touch» list
`packages/db/prisma/schema.prisma` and NPI migrations (except T-00 fixes); `common/posting.service.ts`; approval matrix and workflow engine code; existing endpoint contracts; `apps/web` (only one nav link to `/copilot` is added in T-08); `deploy.sh` semantics (extend, do not rewrite); seed of NPI (copilot seed is separate).
