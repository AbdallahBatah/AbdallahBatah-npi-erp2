# A1 — Removal footprint: Plant monitoring (`/telemetry`) and PPA & settlement (`/ppa`)

- Repository: `C:\dev\npi-erp`, branch `feat/copilot` @ `1a4d545` (working tree clean except untracked `deploy/NEXT_DEPLOY_T47_AR.md`).
- Sections in scope: «مراقبة المحطات» (web route `/telemetry`, nav key `nav.telemetry`, API module `apps/api/src/modules/telemetry`) and «عقود الطاقة والتسوية» (web route `/ppa`, nav key `nav.ppa`, API module `apps/api/src/modules/ppa`).
- Mode: strictly read-only. Evidence = direct reads plus `git grep`/`grep` over tracked files. Every claim carries `path:line`. Anything I could not confirm is written **not verified**; anything derived from reading code (not from running it) is written **by code reading**.

---

## 0. Method, base and limits

- **Code parity.** `git diff --stat origin/main feat/copilot -- apps packages scripts deploy` shows exactly one differing file (`apps/copilot/tests/docs.spec.ts`). Local `main` (9aae4f2) lags `origin/main` (d971454, PR #11), so a removal branch should start from `feat/copilot` or `origin/main`, never from local `main`.
- **CRM worktree** (`C:\dev\npi-erp-crm`, `feature/crm-phase-1` @ edd8242) is an ancestor of `feat/copilot` (`git merge-base --is-ancestor` true). For the paths in this report it differs only by Q-5 sweep edits and the missing `/copilot` nav item (`git diff feat/copilot feature/crm-phase-1 -- apps/web/src/lib/nav.ts`). Nothing extra to account for there.
- **Not read, per instruction:** `docs/archive/**`, `docs/COPILOT_PROGRESS_ARCHIVE.md`, `PROGRESS.md`, `testsprite_tests/**` (file NAMES listed with `git ls-files` only), `perf/**`, `package-lock.json`, `.claude/worktrees/**`. `apps/copilot/src/npi/openapi.json` was only grepped and parsed for its path keys (a one-off Python read that lists keys; nothing written). `apps/copilot/eval/*.json` were only grepped.
- **Not done:** no server, test, build or lint run; no live DB or server query. Everything about live rows, live roles or the live crontab is **not verified** unless a repo file states it (then the file is cited).
- Line numbers are from the working tree at `1a4d545`.

### 0.1 The two sections in one picture

```
TelemetryModule (8 routes) --writes--> TelemetryReading, PerformanceAlert,
      |                                WorkOrder(origin ALERT), Notification(type ALERT_WORKORDER),
      |                                NumberingSequence(ALERT, WORK_ORDER), AuditLog
      |   ^ FsmService.close() sets alerts RESOLVED (fsm.service.ts:388-393)  <- only foreign code touching telemetry tables
      v
PpaModule (4 routes) --reads TelemetryReading (ppa.service.ts:166)
      |  --writes--> PpaTerm, SettlementRun, Contract(type PPA, ACTIVE, inline), Invoice(type SETTLEMENT, DRAFT)+InvoiceLine,
      |              NumberingSequence(CONTRACT, PPA_TERM, INVOICE, SETTLEMENT), AuditLog
      v
Finance (generic, no PPA code): POST /api/finance/invoices/:id/issue -> ZATCA e-invoice + one journal (Dr AR / Cr Revenue / Cr VAT)
```

Neither module imports the other, and no other module imports either of them (only `apps/api/src/app.module.ts:20-21,46-47`). Both rely on the global `KernelModule` (`apps/api/src/common/kernel.module.ts`) and Prisma. PPA settlement has a hard data dependency on telemetry readings (`ppa.service.ts:166-171`).

### 0.2 Size of the footprint at a glance

| Area | Telemetry | PPA |
|---|---|---|
| Web pages | 1 (`(app)/telemetry/page.tsx`, 252 lines) | 1 (`(app)/ppa/page.tsx`, 330 lines) |
| API files / lines | 4 / 543 | 4 / 338 |
| API routes | 8 | 4 |
| Prisma models | `TelemetryReading`, `PerformanceAlert` | `PpaTerm`, `SettlementRun` |
| Prisma enums used only by them | `AlertType`, `AlertSeverity`, `AlertStatus` | `BillingCycle`, `PpaStatus`, `SettlementStatus` |
| Relations from core models | 5 (Organization x2, Asset x2, WorkOrder x1) | 5 (Organization x2, Contract, Project, Invoice) |
| Migrations | `0006_w5_telemetry` | `0007_w6_ppa`, one index in `0009_m0_harden` |
| i18n lines in `messages.ts` | 38 (`tel.*`) + 2 (`nav.telemetry`) + 4 (`confirm.simulate*`) | 40 (`ppa.*`) + 2 (`nav.ppa`) + 4 (`confirm.settle*`) |
| Permission keys that exist ONLY for it | **none** | **none** |
| Seed touchpoints | numbering `ALERT`; `seed-demo.js` step 6 | numbering `PPA_TERM`, `SETTLEMENT`; `seed-demo.js` step 7 |
| Tests that exercise it | none in api/web; 1 line in `api-smoke.mjs`; 3 TestSprite files (names only) | none in api/web; 2 TestSprite files (names only) |
| Copilot | generated types + 2 copilot-local module keys (`telemetry`, `ppa`) | same, plus `ppa_operator` business profile and contract type `PPA` (generic) |

---

## 1. Plant monitoring («مراقبة المحطات», `/telemetry`)

### 1.1 Web

**Files.** Exactly one: `apps/web/src/app/(app)/telemetry/page.tsx` (252 lines, `'use client'`). The directory holds nothing else (no sub-routes, no dedicated component in `apps/web/src/components`).

**API calls made by the page** (every other telemetry route has no web caller; checked with `git grep telemetry/ apps/web/src`):

| Call | Line |
|---|---|
| `GET /telemetry/dashboard` | `page.tsx:55` |
| `GET /telemetry/alerts` | `page.tsx:56` |
| `GET /projects` (shared endpoint, feeds the simulate button) | `page.tsx:57` |
| `POST /telemetry/simulate` (`{projectId: projects[0], days: 14, badDayOffset: 2}`) | `page.tsx:71` |
| `POST /telemetry/alerts/:id/acknowledge` | `page.tsx:224` |
| `POST /telemetry/alerts/:id/work-order` | `page.tsx:236` |
| no web caller: `POST /telemetry/readings`, `GET /telemetry/readings`, `GET /telemetry/assets/:id/history` | none |

**In-page permission gates:** `<Can perm="fsm.workorder.write">` at `page.tsx:81` (Simulate) and `:217` (Acknowledge, Raise work order). Outbound link: alert row to `/workorders/:id` (`page.tsx:208`).

**Navigation.** `apps/web/src/lib/nav.ts:52` is `{ href: '/telemetry', key: 'nav.telemetry', icon: 'activity', perm: 'fsm.workorder.read' }`. It is consumed by the sidebar (`apps/web/src/app/(app)/layout.tsx:119-131`, perm filter `:121`) and by the Ctrl+K palette (`apps/web/src/components/global-search.tsx:16,84`), so one edit in `nav.ts` removes both.

**There is no route-level guard.** No `apps/web/src/middleware.ts` and no `apps/web/middleware.ts` exist; `(app)/layout.tsx:51-53` only redirects unauthenticated users; `apps/web/next.config.mjs` (11 lines) has no `redirects` or `rewrites`. A logged-in user can open `/telemetry` by typing it. The real gate is the API permission.

**i18n (`apps/web/src/lib/messages.ts`, two flat dictionaries: `ar` lines 5-1231, `en` 1232-2459):**

| Prefix | Count | Lines |
|---|---|---|
| `tel.*` | 19 keys x 2 locales = 38 lines | ar `1095-1113`, en `2319-2337` |
| `nav.telemetry` | 2 | ar `1094`, en `2318` |
| `confirm.simulateTitle`, `confirm.simulateMsg` (used only by this page, `page.tsx:68`) | 4 | ar `80-81`, en `1299-1300` |

`tel.detectedAt` (`messages.ts:1107`, `:2331`) is unused anywhere (`git grep`). Shared keys the page reuses and which must stay: `common.code/status/actions/none`, `wo.asset` (`page.tsx:176`).

**Other web strings tied to telemetry (cosmetic or shared):**

- `apps/web/src/lib/errors.ts:19` — regex `/no PLANT asset yet/` (raised by `telemetry.service.ts:226`).
- `apps/web/src/components/ui.tsx:331-333` — badge styles `ACKNOWLEDGED`, `WORK_ORDERED`, `RESOLVED` (no other page uses these statuses; `git grep`).
- `apps/web/src/components/audit-log.tsx:68` — `PerformanceAlert: 'تنبيه أداء'` (keep: historic audit rows still carry this entity type).
- `apps/web/src/lib/useEnums.ts:46-48` — the `alertTypes`, `alertSeverities`, `alertStatuses` fields.
- `apps/web/src/app/login/page.tsx:51-52` — login-screen bullet «مراقبة المحطات وتسوية PPA» / "Plant monitoring & PPA settlement".
- `packages/shared/src/permissions.ts:163-164` — role-editor label «عرض أوامر العمل والمراقبة» / "View work orders & telemetry" (the only place those strings exist).

**References from OTHER pages and widgets:**

- **Dashboard tile**, `apps/web/src/app/(app)/dashboard/page.tsx`: interface `TelDash` `:29`; state `:46`; flag `canOps = can('fsm.workorder.read')` `:54`; fetch `api.get('/telemetry/dashboard')` `:62` (inside `if (canOps)`, failure swallowed by `.catch(() => setTel(null))`); the card `<Link href="/telemetry" className="stat group">` `:183-211` (14-day kWh, portfolio PR, open alerts); the row-2 grid width counts the ops block as TWO tiles, `(canOps ? 2 : 0)` at `:132`; a hard-coded workflow chip «تشغيل + تسوية» / "Operate + settle" at `:236-242`.
- Project, contract, invoice, work-order and asset pages: no link to `/telemetry` (`git grep`). The only other mention is a comment at `apps/web/src/app/(app)/projects/page.tsx:54` ("the /ppa defect class").
- **Global search / command palette:** only through `NAV_ITEMS` (above). The entity-search groups (`global-search.tsx:31-41`) and the API search service (`apps/api/src/modules/search/search.service.ts`) contain no telemetry or PPA group.
- **Notifications:** telemetry writes `ALERT_WORKORDER` notifications whose `linkPath` is `/workorders/:id` (`telemetry.service.ts:194,349`), not `/telemetry`; the bell (`apps/web/src/components/notifications.tsx:16,101`) routes by `linkPath` only and never switches on `type`. Existing notification rows stay valid after a removal.

### 1.2 API

**Registration.** `apps/api/src/app.module.ts:20` (import) and `:46` (imports array). `telemetry.module.ts:5-9`: `controllers: [TelemetryController]`, `providers: [TelemetryService]`, no `imports`.

**Controller** `apps/api/src/modules/telemetry/telemetry.controller.ts` (class-level `@UseGuards(PermissionsGuard)` `:10`; global prefix `api` is set at `apps/api/src/main.ts:18`):

| Route | Permission (shared key) | Lines |
|---|---|---|
| `POST /api/telemetry/readings` (TEL-01 batch ingest, max 500 rows, `dto.ts:26-31`) | `fsm.workorder.write` | `:15-19` |
| `POST /api/telemetry/simulate` (simulated connector) | `fsm.workorder.write` | `:22-26` |
| `GET /api/telemetry/readings?assetId&days` | `fsm.workorder.read` | `:28-36` |
| `GET /api/telemetry/alerts` | `fsm.workorder.read` | `:38-42` |
| `POST /api/telemetry/alerts/:id/acknowledge` | `fsm.workorder.write` | `:44-48` |
| `POST /api/telemetry/alerts/:id/work-order` (FSM-11 manual path) | `fsm.workorder.write` | `:50-55` |
| `GET /api/telemetry/dashboard` (14-day portfolio) | `fsm.workorder.read` | `:57-61` |
| `GET /api/telemetry/assets/:id/history` (AST-02) | `assets.serialunit.read` | `:63-68` |

**Service** `telemetry.service.ts` (426 lines): `expectedDailyKwh` `:35-53`; `ingest` `:57-124`; private `raiseAlert` `:127-213`; `simulate` `:217-248`; `readings` `:252-263`; `alerts` `:265-274`; `acknowledge` `:276-296`; `raiseWorkOrder` `:299-355`; `dashboard` `:359-395`; `assetHistory` `:398-425`. Rule engine (doc comment `:15-24`): energy 0 with expected > 0 gives OFFLINE/CRITICAL `:98-104`; PR < 0.5 gives UNDERPERFORMANCE/CRITICAL `:105-111`; PR < 0.8 gives WARNING `:112-119`; one live alert per asset and type `:133-141`.

**Schedulers, queues, event listeners:** none in the module (no `@Cron`, `@Interval`, `@OnEvent`, queue or outbox call; `git grep` over `apps/api/src`). The only crons in the API are `approval-escalation.scheduler.ts:31`, `event-dispatcher.service.ts:68`, `proposal-expiry.scheduler.ts:30`, `follow-up-reminder.scheduler.ts:48`, `fsm.scheduler.ts:17`; none relates to telemetry or PPA.

**Who calls into it.** Nobody imports `TelemetryModule` or `TelemetryService` (only `app.module.ts`). The only foreign code that touches its tables is `apps/api/src/modules/fsm/fsm.service.ts:388-393`, inside `close()`: `tx.performanceAlert.updateMany({ where: { workOrderId: wo.id, status: { not: 'RESOLVED' } }, data: { status: 'RESOLVED', resolvedAt } })`. That is a Prisma-level dependency; `FsmModule` does not import `TelemetryModule` (`fsm.module.ts:1-10`). `ppa.service.ts:166` reads `telemetryReading`.

**What it calls.**

- `NumberingService`: `'ALERT'` `:144`, `'WORK_ORDER'` `:164` and `:309`. `AuditService`: `:200`, `:286`, `:328`. `NotificationService.notify`: `:185-197`, `:339-352` (type `ALERT_WORKORDER`, audience = users holding `fsm.workorder.read`).
- **Work orders: yes, written directly.** It does not call `FsmService`. It inserts `WorkOrder` rows itself with `woType 'CORRECTIVE'`, `origin 'ALERT'`, `priority 'CRITICAL'`, `slaDueAt` +48 h (`:165-179`), then flips the alert to `WORK_ORDERED` (`:180-183`), all inside the same transaction as the alert (CRITICAL path). WARNING/INFO alerts get a work order only through the manual route (`:299-355`, priority HIGH/MEDIUM `:319`). Closing the work order resolves the alert (`fsm.service.ts:388-393`). Telemetry raises alerts and work orders only: no invoices, no journal entries.
- Reads: `project -> contract -> proposalRevision -> designVersion.expectedAnnualKwh` for the expected daily yield (`:37-48`, fallback `capacityKwp x 4.5` `:49-52`); `asset`, `serialUnit`, `goodsReceipt.code` (`:399-406`).

### 1.3 Database

**Models** (`packages/db/prisma/schema.prisma`): `TelemetryReading` `:1785-1802` (unique `[assetId, readingDate]` `:1800`); `PerformanceAlert` `:1806-1830` (`workOrderId @unique` `:1823`, relation to the reading `:1814`). **Enums used only by them:** `AlertType` `:1762-1767`, `AlertSeverity` `:1769-1773`, `AlertStatus` `:1775-1780` (used at `:1815-1817`).

**Relations from core models into them:** `Organization.telemetryReadings` `:264`, `Organization.performanceAlerts` `:265`, `Asset.telemetryReadings` `:1668`, `Asset.performanceAlerts` `:1669`, `WorkOrder.alert PerformanceAlert?` `:1708`. Nothing on `Project`, `Invoice` or `SerialUnit`.

**Migration:** `packages/db/prisma/migrations/0006_w5_telemetry/migration.sql`: enums `:2,:5,:8`; tables `:11,:26`; indexes `:47-62`; FKs `:65-80` (org CASCADE; asset RESTRICT; reading SET NULL; work order SET NULL). No later migration touches these two tables (`git grep` over `packages/db/prisma/migrations`).

**Shared-enum values written only by telemetry:**

| Shared thing | Value | Evidence |
|---|---|---|
| Prisma enum `WoOrigin` | `ALERT` | `schema.prisma:1623`; migration `0005_w4_operate/migration.sql:11`; only writers `telemetry.service.ts:173,318`; label `packages/shared/src/enums.ts:283` |
| `Notification.type` (a free `String`, not an enum) | `ALERT_WORKORDER` | `schema.prisma:2185`; writers `telemetry.service.ts:189,344`; no reader anywhere |
| `NumberingSequence.documentType` | `ALERT` (prefix `ALR`) | `seed.ts:233`, `madar-scratch-orgs.ts:164`; used at `telemetry.service.ts:144` |
| `AuditLog.entityType` | `PerformanceAlert` | `telemetry.service.ts:204,290,332`; label `audit-log.tsx:68` |

**Not exclusive (do not remove):** `AssetType.PLANT` (the install flow creates PLANT roots: `apps/api/src/modules/procurement/procurement.service.ts:1486-1503`; the work-order form filters it out, `workorders/page.tsx:369`), numbering `WORK_ORDER`, the `WorkOrder` table itself.

**`@npi/shared` mirrors:** `ALERT_TYPES` `enums.ts:319`, `ALERT_SEVERITIES` `:326`, `ALERT_STATUSES` `:332`, served by `apps/api/src/modules/reference/reference.controller.ts:45-47,96-98`. Only `alertTypes` and `alertSeverities` are used by a page (`telemetry/page.tsx:195,198`); `alertStatuses` is used by nothing.

### 1.4 Seed and demo data

- `packages/db/prisma/seed.ts` writes no telemetry rows; only the numbering sequence `ALERT` (`:233`). `packages/db/prisma/madar-scratch-orgs.ts:164` likewise. `packages/db/prisma/madar-e2e-db.mjs`, everything under `deploy/` except docs, and `apps/copilot/e2e/fixtures` contain no reference (`git grep`).
- `scripts/seed-demo.js:239-242` calls `POST /telemetry/simulate {days: 14, badDayOffset: 3}` for the hospital project. **By code reading** that yields 14 `TelemetryReading` rows, exactly ONE CRITICAL `PerformanceAlert` (the 30 % day, `telemetry.service.ts:236-238`; the healthy band 88-104 % never trips the 0.8 rule), one auto-created CORRECTIVE work order with `origin ALERT`, and one `ALERT_WORKORDER` notification per user holding `fsm.workorder.read`. `step()` swallows failures (`seed-demo.js:43-52`), so a missing endpoint prints "skipped" and the script continues.
- The demo reset runs `prisma migrate reset`, then `seed.ts`, then `seed-demo.js` (`deploy/docker-compose.demo-reset.yml:51-54`). `deploy/README_AR.md:88` and `deploy/NEXT_DEPLOY_T47_AR.md:41` say the demo server's cron runs it at 03:00; the live crontab is **not verified** here.
- No seeded invoice or journal entry originates from telemetry.

### 1.5 Permissions

**No permission key exists only for telemetry.** `packages/shared/src/permissions.ts:6-77` has no `telemetry.*` key. The routes use three shared keys:

- `fsm.workorder.read` (`PERMISSIONS.WORKORDER_READ`): `GET readings`, `GET alerts`, `GET dashboard` (`telemetry.controller.ts:29,39,58`), nav item (`nav.ts:52`), dashboard tile (`dashboard/page.tsx:54`).
- `fsm.workorder.write`: `POST readings`, `simulate`, `acknowledge`, `work-order` (`:16,23,45,52`), page buttons (`page.tsx:81,217`).
- `assets.serialunit.read`: `GET assets/:id/history` (`:65`).

These are the same keys the FSM and asset screens use (`fsm.controller.ts:25,31-154`, `procurement.controller.ts:190`, `search.service.ts:220,244`). Gating by permission therefore cannot hide telemetry without also hiding work orders and assets.

**Role seeds** (`packages/db/prisma/seed.ts`; roles created `:117-155`; reseed re-applies `update: { permissions }`): `fsm.workorder.read` goes to admin (`ALL_PERMISSIONS` `:18-35`), executive (every `.read`/`.approve` key `:75-84`), pm (`:68`), site_engineer (`:89`). `fsm.workorder.write` goes to admin and site_engineer (`:89`). `assets.serialunit.read` goes to admin, executive, pm (`:65`), site_engineer (`:90`). Live role sets are editable in the role editor; live values **not verified**.

### 1.6 Tests

| Layer | Result |
|---|---|
| `apps/api` unit specs (`src/**/*.spec.ts`) and integration specs (`test/*.int-spec.ts`) | **No file references telemetry.** The only "plant" hits are customer fixtures named "Riyadh Plant" (`activities.service.spec.ts:23`, `follow-up-reminder.scheduler.spec.ts:22`, `follow-up-tasks.service.spec.ts:26`, `inbox.service.spec.ts:24`). No spec boots `AppModule` (`git grep AppModule` in tests: none). |
| `apps/web` | No tests at all (`apps/web/package.json:5-10`: dev, build, start, typecheck only). |
| Project testing skill `.claude/skills/npi-erp-testing/scripts/api-smoke.mjs` | `:67` `['/telemetry/dashboard', 'fsm.workorder.read']` is a guarded-route row. The loop at `:210-217` expects 403 for roles without the key and not-403 for roles with it. After the module is removed the route returns 404, so the check **fails for every role lacking `fsm.workorder.read`** (sales, accountant). `ui-sweep.js` walks the sidebar dynamically (`:17-18`), nothing hard-coded. `SKILL.md:125,128` hard-codes "all 19" and "7 against admin's 19" (already stale: `nav.ts` has 26 items). |
| `scripts/crm-phase-1-*-acceptance.mjs` | No reference; sidebar links are counted dynamically (`crm-phase-1-ui-acceptance.mjs:263-280`). |
| TestSprite (file names only; contents not read; `CLAUDE.md` says they are not part of any gate) | `testsprite_tests/TC030_View_telemetry_dashboard_readings_and_alerts.py`, `TC035_Open_the_telemetry_dashboard_and_acknowledge_an_alert.py`, `TC041_Acknowledge_a_telemetry_alert.py` |
| Copilot Jest and Playwright | Nothing asserts a telemetry endpoint. `apps/copilot/e2e/settings.spec.ts:96-98` asserts the copilot's own `telemetry` module checkbox exists and is unchecked for the EPC profile (see 1.7). |

CI (`.github/workflows/ci.yml:39-56`) runs typecheck for all workspaces, lint, `npm test` (the root script runs only `@npi/api`, `package.json:24`), API build and web build. Copilot Jest and Playwright are not CI gates.

### 1.7 Copilot (`apps/copilot`)

- **No tool, flow, prompt or client code calls a telemetry endpoint** (`git grep` of `apps/copilot/src` excluding the generated `npi/types.ts`). The copilot has exactly five flows (`apps/copilot/src/onboarding/profile.schema.ts:57`; `spec/madar/08-CLAUDE-CODE-KICKOFF.md` section E.10).
- **Generated snapshot of NPI's OpenAPI.** `apps/copilot/src/npi/types.ts`: paths `/api/telemetry/alerts` `:2303`, `.../acknowledge` `:2319`, `.../work-order` `:2335`, `.../assets/{id}/history` `:2352`, `.../dashboard` `:2369`, `.../readings` `:2385`, `.../simulate` `:2402`; operations `TelemetryController_*` `:6380-6516`. `apps/copilot/src/npi/openapi.json` has the same 8 operations plus schemas `IngestDto`, `ReadingDto`, `SimulateDto` (path-key parse; 36 matching lines in each file for PPA and telemetry together). Regenerate with `npm run copilot:gen-types` (root `package.json`; `apps/copilot/scripts/gen-npi-types.mjs`: offline mode rebuilds `types.ts` from the committed JSON, `--fetch` needs a local API started with `EXPOSE_API_DOCS=1`, `apps/api/src/main.ts:44`). No CI step compares the snapshot with the live API.
- **Copilot-local module key `telemetry`** (a Madar configuration concept, not an NPI screen):
  - `profile.schema.ts:38` (`MODULE_KEYS`) and `:52` (`MODULE_NAMES_AR.telemetry = 'المراقبة والقياس'`);
  - `apps/copilot/src/onboarding/discover.ts:133` (`telemetry: ['telemetry.']`);
  - `apps/copilot/catalog/profiles/ppa_operator.json:5` (`visibleModules`);
  - five overlays tell the model the module is out of scope: `prompts/overlays/epc.md:5`, `engineering_consulting.md:5`, `equipment_trading.md:5`, `general_contracting.md:5`, `om_provider.md:5`;
  - settings UI renders one checkbox per key (`src/components/settings/ModulesCard.tsx:62-77`) and the API accepts it (`src/settings/service.ts:134`);
  - eval samples expect it hidden (`apps/copilot/eval/setup-samples.json:17,35,71,89,107`, consumed by `e2e/setup-live.spec.ts:376-378`);
  - Jest `tests/overlays.spec.ts:69-77` requires every overlay to name every hidden module by its `MODULE_NAMES_AR` value;
  - binding spec: `spec/madar/02-TECH-SPEC.md:90`, `03-DESIGN-SPEC.md:42`, `06-ACCEPTANCE-TESTS.md:37` (AT-11).
- **The `telemetry.` permission prefix in `discover.ts:133` matches nothing.** NPI defines no permission starting with `telemetry.` or `ppa.` (`packages/shared/src/permissions.ts:6-77`), so these two modules can never enter `heldModules` (`discover.ts:155-161`).

### 1.8 Owner docs

- Nothing under `docs/*.md` (excluding `docs/archive`) describes the screen. A case-insensitive search of `docs/*.md`, `docs/crm-phase-1/*.md` and `deploy/*.md` for `telemetry`, `/telemetry`, «مراقبة المحطات», «المحطات», «إنذار» and «معامل الأداء» finds no description of it.
- Describing it: root `README.md:22` (W5 row), `:26` (roadmap sentence), `:178-183` (endpoint list incl. AST-02), `:221` (roadmap row). Specs: see 1.7. `docs/archive/**` was not inspected (it may contain older reports of the screen).

---

## 2. PPA and settlement («عقود الطاقة والتسوية», `/ppa`)

### 2.1 Web

**Files.** Exactly one: `apps/web/src/app/(app)/ppa/page.tsx` (330 lines, `'use client'`); the directory holds nothing else.

**API calls made by the page:**

| Call | Line |
|---|---|
| `GET /ppa/terms` | `page.tsx:73` |
| `GET /ppa/runs` | `page.tsx:74` |
| `GET /projects` (only if `can('projects.project.read')`) | `page.tsx:78-79` |
| `GET /contracts` (only if `can('commercial.contract.read')`; client-side filter to ACTIVE PPA/OM) | `page.tsx:81-87` |
| `POST /ppa/terms` | `page.tsx:260` |
| `POST /ppa/terms/:id/settle` | `page.tsx:315` |

**In-page gates:** `<Can perm="commercial.contract.write">` `:108` (new terms), `<Can perm="finance.invoice.write">` `:157` (settle). Outbound link: run row to `/invoices/:id` (`:208`).

**Navigation.** `apps/web/src/lib/nav.ts:53` is `{ href: '/ppa', key: 'nav.ppa', icon: 'zap', perm: 'finance.invoice.read' }`; same consumers as telemetry (sidebar `layout.tsx:119-131`, palette `global-search.tsx:84`). Same absence of a route guard (see 1.1).

**i18n (`apps/web/src/lib/messages.ts`):**

| Prefix | Count | Lines |
|---|---|---|
| `ppa.*` | 20 keys x 2 locales = 40 lines | ar `1116-1135`, en `2340-2359` |
| `nav.ppa` | 2 | ar `1115`, en `2339` |
| `confirm.settleTitle`, `confirm.settleMsg` (used only by this page, `page.tsx:308-309`) | 4 | ar `72-73`, en `1291-1292` |

Dead keys: `ppa.cycle` (`:1124`, `:2348`) and `ppa.start` (`:1125`, `:2349`) are unused by any component. Shared keys the page reuses and which must stay: `fin.vat.from`/`fin.vat.to` (`page.tsx:290,293`), `inv.subtotal` (`:185`), `common.*`.

**Other web strings tied to PPA:**

- `apps/web/src/lib/messages.ts:188` (ar) and `:1405` (en): the invoices empty-state hint `inv.emptyHint` says invoices come from milestones "or from energy-contract settlements".
- `apps/web/src/lib/errors.ts:41` (`/period overlaps/`, from `ppa.service.ts:158`) and `:42` (`/no telemetry readings/`, from `ppa.service.ts:170`).
- `apps/web/src/components/ui.tsx:334-335`: badge style `ENDED`, under a `// ppa` comment (only PPA uses that status).
- `apps/web/src/components/audit-log.tsx:69-70`: `PpaTerm: 'اتفاقية شراء طاقة'`, `SettlementRun: 'تسوية طاقة'` (keep: historic audit rows).
- `apps/web/src/app/login/page.tsx:51-52` and the dashboard chip `dashboard/page.tsx:236-242` (see 1.1).

**References from OTHER pages:** none. The only occurrences of the string `/ppa` outside the page itself are `nav.ts:53` and the comment at `projects/page.tsx:54`. The invoice list, detail and print pages branch on `CREDIT_NOTE` only (`invoices/page.tsx:97`, `invoices/[id]/page.tsx:145`, `invoices/[id]/print/page.tsx:89`) and never show or link a settlement run. Contract pages show the contract type through `enums.contractTypes` (`contracts/page.tsx:89`, `contracts/[id]/page.tsx:126`, `customers/[id]/page.tsx:425`, `opportunities/[id]/page.tsx:435`) — generic. The proposal page offers all four contract types, including PPA, when creating a contract (`proposals/[id]/page.tsx:1010-1011`). No notification type or palette entry points at `/ppa`.

### 2.2 API

**Registration.** `apps/api/src/app.module.ts:21` (import) and `:47` (imports array). `ppa.module.ts:5-9`: `controllers: [PpaController]`, `providers: [PpaService]`, no `imports`.

**Controller** `apps/api/src/modules/ppa/ppa.controller.ts` (class-level `@UseGuards(PermissionsGuard)` `:10`):

| Route | Permission (shared key) | Lines |
|---|---|---|
| `GET /api/ppa/terms` | `finance.invoice.read` | `:14-18` |
| `POST /api/ppa/terms` (`CreatePpaTermDto`, `dto.ts:5-17`) | `commercial.contract.write` | `:20-24` |
| `POST /api/ppa/terms/:id/settle` (`SettleDto`, `dto.ts:19-22`) | `finance.invoice.write` | `:26-31` |
| `GET /api/ppa/runs` | `finance.invoice.read` | `:33-37` |

**Service** `ppa.service.ts` (269 lines): `listTerms` `:33-43`; `listRuns` `:45-54`; `createTerm` `:57-128`; `settle` `:134-268`. Settle guards: term must be ACTIVE `:140`; valid period `:142-146`; no overlapping INVOICED run `:148-159`; the project must own a PLANT asset `:162-165`; at least one reading in the period `:166-171`. Maths: energy = sum of readings `:172`; escalation compounded from the term start `:174-180`; VAT from `TaxService.standardVat` `:185-187`.

**Schedulers, queues, events:** none. Settlement is manual. `billingCycle` is stored (`:108`) but never read by any code, `endDate` is stored (`:110`) but never enforced, and nothing ever sets a term to SUSPENDED/ENDED or a run to CANCELLED (`git grep billingCycle`, `git grep -w ENDED`; the schema comment at `schema.prisma:1899-1902` says run cancellation is "if ever implemented"). In live data every `PpaTerm` is therefore ACTIVE and every `SettlementRun` INVOICED (by code reading; live rows **not verified**).

**Who calls into it:** nobody (only `app.module.ts`). `apps/api/src/modules/commercial/dto.ts:15` holds a literal contract-type list `['EPC','PPA','OM','LEASE']`, which is data, not a call.

**What it calls.** `PpaService` injects only `PrismaService`, `NumberingService`, `AuditService`, `TaxService` (`:26-31`). It does **not** use `InvoicesService`, `PostingService` or `ZatcaService`:

- **Contract (inline path)** `:77-96`: `tx.contract.create` with `contractType 'PPA'`, `status 'ACTIVE'`, no `opportunityId`, no `proposalId`, no milestones, `totalValue` left at 0; numbering `'CONTRACT'` `:84`. This bypasses `ContractsService.create`, which starts contracts as DRAFT (`commercial/contracts.service.ts:119`), requires an accepted proposal revision when one is given (`:66-90`) and fires the CRM "opportunity won" hook (`:107`).
- **Invoice** `:219-235`: `tx.invoice.create` directly, `invoiceType 'SETTLEMENT'`, `status 'DRAFT'`, `retentionAmount 0`, lines created inline, numbering `'INVOICE'` `:192`. **No journal entry and no e-invoice are created by PPA.**
- `SettlementRun` `:237-253` (numbering `'SETTLEMENT'` `:237`), audit rows `:115-125`, `:255-265`.
- Reads `Project`, `Contract`, `Customer`, `Asset` (PLANT) and `TelemetryReading` (`:166-168`).

**How a settlement becomes money.** A person (or script) issues the draft through the generic finance route `POST /api/finance/invoices/:id/issue` (`finance/invoices.controller.ts:36-40` -> `invoices.service.ts:209-350`), which writes the `EInvoiceDocument` (PIH chain) and ONE journal (Dr AR net payable, Cr REVENUE subtotal, Cr VAT_OUTPUT; `:235-242`, `:297-304`) and flips the invoice to CLEARED (`:318-321`). Nothing in that path branches on `invoiceType`; the journal memo is hard-coded `Milestone invoice <code>` even for a settlement (`invoices.service.ts:302`). The link from a posted invoice back to PPA is only `SettlementRun.invoiceId` and `invoiceType = 'SETTLEMENT'`.

### 2.3 Database

**Models** (`packages/db/prisma/schema.prisma`): `PpaTerm` `:1852-1874` (`contractId @unique` `:1857`, `projectId` `:1859`); `SettlementRun` `:1878-1904` (`invoiceId @unique` `:1894`; `@@unique([ppaTermId, periodStart, periodEnd])` `:1903`). **Enums used only by them:** `BillingCycle` `:1834-1837`, `PpaStatus` `:1839-1843`, `SettlementStatus` `:1845-1848`.

**Relations from core models into them:** `Organization.ppaTerms` `:266`, `Organization.settlementRuns` `:267`, `Contract.ppaTerm PpaTerm?` `:801`, `Project.ppaTerms PpaTerm[]` `:1235`, `Invoice.settlementRun SettlementRun?` `:899`. Nothing on `WorkOrder` or `SerialUnit`.

**Migrations:** `packages/db/prisma/migrations/0007_w6_ppa/migration.sql` — enums `:2,:5,:8`; tables `:11,:30`; indexes `:51-66`; FKs `:69-84` (org CASCADE; contract RESTRICT; project RESTRICT; term RESTRICT; invoice SET NULL). `0009_m0_harden/migration.sql:18-21` swaps the plain index for the unique `SettlementRun(ppaTermId, periodStart, periodEnd)` index.

**Shared-enum values written only by PPA:**

| Shared thing | Value | Evidence |
|---|---|---|
| Prisma enum `InvoiceType` | `SETTLEMENT` | `schema.prisma:178`; migration `0002_w3_finance/migration.sql:8`; only writer `ppa.service.ts:223`; label `packages/shared/src/enums.ts:113`; type `packages/shared/src/invoicing.ts:19` |
| `NumberingSequence.documentType` | `PPA_TERM` (prefix `PPA`), `SETTLEMENT` (prefix `STL`) | `seed.ts:234-235`, `madar-scratch-orgs.ts:165-166`; used at `ppa.service.ts:98,237` |
| `AuditLog.entityType` | `PpaTerm`, `SettlementRun` | `ppa.service.ts:119,259`; labels `audit-log.tsx:69-70` |
| `Contract` rows | inline contracts with `contractType PPA`, `status ACTIVE`, no proposal | `ppa.service.ts:84-94` (see 2.2) |

**Not exclusive (do not remove):** `ContractType.PPA` and `OM` (`schema.prisma:133-134`): contracts of these types are created through the normal contract path too (`commercial/dto.ts:15,97`, `proposals/[id]/page.tsx:1010-1011`, and the copilot's contract extraction, 2.7). `BillingCycle` is used by `PpaTerm` only.

**`@npi/shared` mirrors:** `BILLING_CYCLES` `enums.ts:308` and `PPA_STATUSES` `:313` are exported but imported nowhere (`BILLING_CYCLES` is re-declared in `ppa/dto.ts:3`). `INVOICE_TYPES` (`enums.ts:111`, SETTLEMENT at `:113`) is served to the web by `reference.controller.ts:78` and drives nothing PPA-specific.

**Posted financial documents.** No table links a journal to PPA directly. A SETTLEMENT invoice, once issued, owns an `EInvoiceDocument` that sits in the per-organization ZATCA PIH chain, a hard database rule: `@@unique([organizationId, previousInvoiceHash])` (`schema.prisma:964`), `Invoice` and `EInvoiceDocument` are `onDelete: Restrict` towards the organization (`schema.prisma:869,940`), and the schema calls issued e-invoices "a statutory record" (`:884-886`, `:930-938`). Such invoices can never be deleted or retyped.

### 2.4 Seed and demo data

- `packages/db/prisma/seed.ts:234-235` and `madar-scratch-orgs.ts:165-166`: numbering sequences only. `seed.ts` itself writes no contract, invoice or journal (model list of its writes: org, role, user, customer, lead, item, vendor, location, accounts and mappings, tax code, pricing scheme, approval rule, workflow, department, activity, task).
- `scripts/seed-demo.js:244-253`: `POST /ppa/terms` (rate 0.29, escalation 2.5 %, fixed fee 3500; no `contractId`, so an inline PPA contract is created for the hospital customer), then `POST /ppa/terms/:id/settle` over the last 14 days (+1 day), then an intended `POST /finance/invoices/:id/issue`.
- **Latent bug (by code reading, not executed):** the issue step is guarded by `run?.invoiceId` (`seed-demo.js:252`), but `settle` returns `{ run, invoice }` (`ppa.service.ts:266`), so `invoiceId` is `undefined` at that level and the step never runs. The seeded SETTLEMENT invoice therefore stays DRAFT: **no journal entry and no e-invoice is seeded from PPA.** The seeded rows are 1 inline PPA contract, 1 `PpaTerm`, 1 `SettlementRun` and 1 DRAFT invoice with 2 lines (energy plus the 3500 fixed fee), plus the numbering rows.
- `seed-demo.js` is not idempotent for this part: each run creates another inline contract and term (`docs/crm-phase-1/step-4-agent-report.md:141`).
- Demo reset: `deploy/docker-compose.demo-reset.yml:51-54` (reset, `seed.ts`, `seed-demo.js`), cron 03:00 per `deploy/README_AR.md:88` and `deploy/NEXT_DEPLOY_T47_AR.md:41`; the live crontab is **not verified**. On such a server all PPA rows are regenerated nightly and are disposable.

### 2.5 Permissions

**No permission key exists only for PPA.** The routes use `finance.invoice.read` (`ppa.controller.ts:15,34`; nav `nav.ts:53`), `commercial.contract.write` (`:21`; page `:108`) and `finance.invoice.write` (`:28`; page `:157`). The page also needs `projects.project.read` and `commercial.contract.read` for its pickers (`page.tsx:78,81`); a missing key must not blank the page — the history of that defect is recorded in `.claude/skills/npi-erp-testing/SKILL.md:131-133`. All keys are shared with invoices (`finance/invoices.controller.ts:15-64`) and contracts (`commercial/contracts.controller.ts:34,40,46`).

**Role seeds** (`packages/db/prisma/seed.ts`): `finance.invoice.read` goes to admin, executive (`:75-84`), sales (`:44`), accountant (`:51`), pm (`:69`). `commercial.contract.write` goes to admin and sales (`:43`). `finance.invoice.write` goes to admin, sales (`:44`), accountant (`:51`). Live role sets **not verified**.

### 2.6 Tests

| Layer | Result |
|---|---|
| `apps/api` unit and integration specs | **None references PPA or settlement.** `invoiceType` appears in specs only as `MILESTONE`/`CREDIT_NOTE` (`finance/credit-note-reporting.spec.ts:102,122-308`). |
| `apps/web` | No tests. |
| `.claude/skills/npi-erp-testing` | `SKILL.md:131-133` documents a past `/ppa` 403-banner defect (history, not an assertion). No `/ppa` row in `api-smoke.mjs` (its guarded routes list has `/telemetry/dashboard` but no PPA route, `:43-71`). |
| TestSprite (file names only, contents not read) | `testsprite_tests/TC042_Run_a_PPA_settlement.py`, `TC044_Review_PPA_terms_and_settlement_area.py` |
| Copilot Jest | None exercises the PPA screen. These mention PPA as a **contract type** or as the **`ppa_operator` business profile**: `tests/eval-memory-data.spec.ts:110` (fixture must contain contract types EPC, PPA, OM, LEASE), `tests/extract-contract.spec.ts:142` (prompt text lists `EPC \| PPA \| OM \| LEASE`), `tests/memory-npi.spec.ts:723-736` (a draft PPA contract with 12.5 % retention yields the expected Arabic fact), `tests/catalog.spec.ts:134` (default approval rule of the `ppa_operator` pack), `tests/onboarding-machine.spec.ts:250,665,678,1074` (the six profile keys; the step-1 hint names `ppa_operator`; the sentence «نبيع الطاقة باتفاقيات PPA ونؤجر الأنظمة» is read as `ppa_operator`), `tests/overlays.spec.ts:19,69-77,80-89` (allowed Latin tokens include PPA; overlays must name every hidden module), `tests/i18n.spec.ts:4-6` and `tests/pseudonymizer.spec.ts:372` (PPA is an allowed/excluded acronym). |
| Copilot Playwright | `e2e/settings.spec.ts:96-98` (`ppa` module checkbox exists and is unchecked for EPC), `e2e/not-found.spec.ts:11` (allowed Latin tokens), `e2e/setup-live.spec.ts:376-378` (expects hidden modules from `eval/setup-samples.json`, a live-LLM run). |

### 2.7 Copilot (`apps/copilot`)

- **No tool, flow, prompt or client code calls a `/ppa` endpoint.**
- **Generated snapshot:** `apps/copilot/src/npi/types.ts` paths `/api/ppa/runs` `:1626`, `/api/ppa/terms` `:1642`, `/api/ppa/terms/{id}/settle` `:1658`; schema `CreatePpaTermDto` `:2599`; request body wiring `:5372`. `openapi.json` has the same 4 operations (`PpaController_listRuns`, `_listTerms`, `_createTerm`, `_settle`) and schemas `CreatePpaTermDto`, `SettleDto`. No copilot source imports `CreatePpaTermDto` or `SettleDto`; the extraction schemas import only the contract, PR, PO, GRN and vendor-bill DTOs (`src/extract/schemas/*.ts` `import type { components } from '../../npi/types'`).
- **Copilot-local module key `ppa`:** `profile.schema.ts:37` (`MODULE_KEYS`), `:51` (`MODULE_NAMES_AR.ppa = 'اتفاقيات بيع الطاقة'`), `discover.ts:132` (`ppa: ['ppa.']`, matches no real NPI permission, see 1.7), `catalog/profiles/ppa_operator.json:5`, the five overlays (line 5 each), settings UI and service, eval samples and the binding spec (all as in 1.7).
- **Business profile `ppa_operator`** (the activity type "sells energy / leases systems", not the ERP screen): `profile.schema.ts:23` (`PROFILE_KEYS`), `catalog/profiles/ppa_operator.json`, `prompts/overlays/ppa_operator.md`, `prompts/setup-parse.md:49`, `src/onboarding/parse.ts:105,223`, `src/i18n/ar.ts:145`, `eval/setup-samples.json:43-44`, `spec/madar/00-START-HERE.md:10`, `02-TECH-SPEC.md:90`, `03-DESIGN-SPEC.md:32,42`. A removal of the ERP screen does not make this profile wrong (a firm can still sell energy under a PPA contract), but its `visibleModules` lists two modules that would no longer exist in NPI.
- **Contract type `PPA`** (generic, keep): `src/extract/schemas/customer_contract.ts:16,50`, `prompts/extract/customer_contract.md:12,19`, `src/i18n/ar.ts:642` (`preview.enum.PPA`), `src/memory/extract-npi.ts:69`, `npi-facts.ts:88`, `npi-snapshot.ts:104`, `src/privacy/pseudonymizer.ts:465`, eval fixtures (`eval/memory-npi-snapshot.json:109,245`, `eval/extract/customer_contract/expected.json:79,242`).

### 2.8 Owner docs

- Nothing under `docs/*.md` (excluding `docs/archive`) describes the screen (same search as 1.8, plus «التسوية», «تسوية», «شراء الطاقة», «بيع الطاقة», «عقود الطاقة»).
- Mentions: root `README.md:23` (W6 row), `:26` (roadmap sentence), `:185-188` (endpoint list), `:222` (roadmap row); `docs/crm-phase-1/step-2-unified-customer-contract.md:10` (lists the PPA among documents that reach the customer through the opportunity or contract); `docs/crm-phase-1/step-4-agent-report.md:141` (records that `seed-demo.js` leaves PPA terms behind). `docs/archive/**` not inspected.

---

## 3. Conclusion (a) — the minimal REVERSIBLE "hide" change set

Goal: remove both sections from the navigation, block the web routes and the API endpoints, keep every table, enum, migration and row.

| # | File | Exact change | Why and effect |
|---|---|---|---|
| 1 | `apps/web/src/lib/nav.ts:52-53` | Delete the `/telemetry` and `/ppa` entries (keep `/workorders` at `:51`). | One edit removes the sidebar links (`(app)/layout.tsx:119-131`) and the Ctrl+K commands (`components/global-search.tsx:84`). The "Operations" group stays because it still holds Work orders. |
| 2 | `apps/web/next.config.mjs` | Add `async redirects()` with two non-permanent redirects, `/telemetry` -> `/dashboard` and `/ppa` -> `/dashboard`. | There is no middleware and the layout only checks login (`layout.tsx:51-53`), so without this both URLs stay reachable by typing them. One file, trivial to revert, the pages stay in the tree and keep type-checking. Alternatives: rename the two route folders under a private `_hidden` folder, or make each `page.tsx` call `notFound()`. |
| 3 | `apps/web/src/app/(app)/dashboard/page.tsx` | Remove `TelDash` (`:29`), the `tel` state (`:46`), the fetch (`:62`) and the tile (`:183-211`); change `(canOps ? 2 : 0)` to `(canOps ? 1 : 0)` at `:132`; optionally drop the «تشغيل + تسوية» chip (`:236-242`). | Otherwise the tile keeps rendering dashes (the `.catch` swallows the 404, `:62`) and links to a redirected URL, and the grid keeps a phantom column. |
| 4 | `apps/web/src/app/login/page.tsx:51-52` | Replace or drop the third highlight. | Cosmetic marketing copy that advertises both sections. |
| 5 | `apps/api/src/app.module.ts:20-21` and `:46-47` | Remove the two import lines and the two entries `TelemetryModule`, `PpaModule` from `imports`. | Unregisters all 12 routes (they answer 404). No other module imports them (verified), no scheduler or listener depends on them. Swagger loses them. `FsmService.close()` keeps working because the `PerformanceAlert` table is intact. |
| 6 | `.claude/skills/npi-erp-testing/scripts/api-smoke.mjs:67` | Delete the `['/telemetry/dashboard', 'fsm.workorder.read']` row. | After step 5 the route is 404 while the check expects 403 for roles without the key (`:210-217`), a false failure for sales and accountant. |
| 7 | optional, noise only: `scripts/seed-demo.js:239-253` | Delete or guard steps 6 and 7. | Without it the nightly demo reset only prints "skipped" for them (`step()` swallows errors, `:43-52`); nothing fails. |

Left untouched on purpose: schema, migrations, `seed.ts`, `@npi/shared` (enums, permissions), `messages.ts` (unused keys are harmless), `errors.ts`, `ui.tsx`, `audit-log.tsx` (history needs its labels), the copilot (its generated types are a static snapshot that nothing calls at runtime).

**Properties of this set**

- Pure code, 4 web files + 1 API file + 1 script (+1 optional); no migration, no data change, one `git revert` restores everything. `deploy/deploy.sh --rollback` is safe because no schema moved (`deploy/MIGRATIONS_AR.md:9`).
- Ship order: web first (the dashboard stops calling the endpoint), then API. The reverse order only leaves a dash-filled tile for the duration of the swap.
- What stays visible afterwards, by design: existing work orders with origin ALERT, any DRAFT or issued SETTLEMENT invoices in `/invoices` and the ledger, inline PPA contracts in `/contracts` and on customer pages, the role-editor label "Work orders & telemetry", the copilot's `ppa`/`telemetry` module checkboxes, README text.
- Suggested verification once implemented (not run here): the CI steps `npm run typecheck`, `npm run lint`, `npm test`, `npm run build -w @npi/api`, `npm run build -w @npi/web` (`.github/workflows/ci.yml:39-56`), then `api-smoke.mjs`, the sidebar sweep for admin and engineer, `GET /api/telemetry/dashboard` and `GET /api/ppa/terms` answering 404, `/telemetry` and `/ppa` redirecting.

---

## 4. Conclusion (b) — what a FULL code removal would additionally touch, and the risks

### 4.1 Additional edits (on top of 3)

**API and shared**

- Delete `apps/api/src/modules/telemetry/*` (4 files, 543 lines) and `apps/api/src/modules/ppa/*` (4 files, 338 lines).
- `apps/api/src/modules/fsm/fsm.service.ts:388-393`: remove the `performanceAlert.updateMany` block (and the comment at `:633-635` that mentions alerts). This is the one place another module reads a telemetry model.
- `apps/api/src/modules/reference/reference.controller.ts:45-47,96-98`: drop the three alert enums; `apps/web/src/lib/useEnums.ts:46-48` matching fields.
- `packages/shared/src/enums.ts`: delete `BILLING_CYCLES` `:308-311`, `PPA_STATUSES` `:313-317`, `ALERT_TYPES/SEVERITIES/STATUSES` `:319-337`. **Keep** `WO_ORIGINS.ALERT` (`:283`), `INVOICE_TYPES.SETTLEMENT` (`:113`), `CONTRACT_TYPES.PPA`/`OM` (`:106-107`), and the `InvoiceTypeLike` union (`invoicing.ts:19`), see 4.2.
- `packages/shared/src/permissions.ts:163-164`: rename the "Work orders & telemetry" labels (needs `npm run build -w @npi/shared`).

**Web**

- Delete the two route folders; delete 90 lines of `messages.ts` (`tel.*` 38, `ppa.*` 40, `nav.telemetry`/`nav.ppa` 4, `confirm.simulate*`/`confirm.settle*` 8) and reword `inv.emptyHint` (`:188`, `:1405`); `errors.ts:19,41,42`; `ui.tsx:331-335`; `login/page.tsx:51-52`; the dashboard pieces from step 3. **Keep** `audit-log.tsx:68-70` (history).

**Database** (`packages/db/prisma/schema.prisma`)

- Remove the relation fields `:264-267`, `:801`, `:899`, `:1235`, `:1668-1669`, `:1708` and the two blocks `:1760-1830` (telemetry) and `:1832-1904` (PPA), about 145 lines.
- Add one NEW migration after `0029_crm_activities` that drops 4 tables (`SettlementRun`, `PpaTerm`, `PerformanceAlert`, `TelemetryReading`) and 6 types (`AlertType`, `AlertSeverity`, `AlertStatus`, `BillingCycle`, `PpaStatus`, `SettlementStatus`). **Never edit `0006`, `0007` or `0009`**: the demo reset replays every migration (`docker-compose.demo-reset.yml:52`, `prisma migrate reset`) and the Madar rules forbid deleting migrations (`spec/madar/08-CLAUDE-CODE-KICKOFF.md` E.4).
- **It must ship as two releases** (`deploy/MIGRATIONS_AR.md:21-29`, rule `:9`): release N removes every reader and writer (including `fsm.service.ts:389`) while the tables remain; release N+1 drops them. Dropping in the same release would break the previous container, which still serves during the swap and still runs `performanceAlert.updateMany` in `close()`, and would break `deploy.sh --rollback`.
- **Do not drop enum values**: `InvoiceType.SETTLEMENT`, `WoOrigin.ALERT`, `ContractType.PPA`/`OM` all have existing rows or live uses (4.2).

**Seeds and scripts:** `packages/db/prisma/seed.ts:233-235` and `madar-scratch-orgs.ts:164-166` (numbering rows; harmless to keep, `NumberingService` only needs rows for types it is asked for, `numbering.service.ts:25-67`), `scripts/seed-demo.js:239-253`, `.claude/skills/npi-erp-testing/scripts/api-smoke.mjs:67`, `SKILL.md:125,128`.

**Copilot**

- Regenerate `src/npi/openapi.json` and `src/npi/types.ts` (36 matching lines each) with `npm run copilot:gen-types -- --fetch` against a local API started with `EXPOSE_API_DOCS=1`; nothing compiles against the removed operations, so this is hygiene, not a fix.
- Decide separately on the copilot-local module keys `ppa` and `telemetry` and the `ppa_operator` profile: `profile.schema.ts:37-38,51-52`, `discover.ts:132-133`, `catalog/profiles/ppa_operator.json:5`, five overlays (line 5), `ModulesCard.tsx`, `settings/service.ts`, `eval/setup-samples.json` (5 `hiddenModules` lists, 1 profile sample), Jest `overlays.spec.ts:69-89`, Playwright `settings.spec.ts:96-98`, and the binding spec `spec/madar/02-TECH-SPEC.md:90`, `03-DESIGN-SPEC.md:32,42`, `06-ACCEPTANCE-TESTS.md:37`. Spec rule E.3 lists `packages/db` schema, existing endpoint contracts and `apps/web` as do-not-touch for the Madar implementer, and E.1 requires logging such conflicts in `PROGRESS.md` -> Deviations (I did not read `PROGRESS.md`). An owner-directed removal is not blocked by them, but it should be recorded there.

**Docs:** `README.md:22-23,26,178-188,221-222`.

### 4.2 Risks

1. **Posted financial documents that came from PPA (highest).** Issued SETTLEMENT invoices have an `EInvoiceDocument` inside the per-organization ZATCA PIH chain (`@@unique([organizationId, previousInvoiceHash])`, `schema.prisma:964`), a journal entry, and possibly payments and credit notes. They cannot be deleted or retyped (`schema.prisma:884-886,930-938`; `Restrict` at `:869,940`). Their only explanation is `SettlementRun` (energy, applied rate, escalation, variable/fixed split, `schema.prisma:1887-1892`) plus the `TelemetryReading` rows that produced the energy; `ppa.service.ts:19-20` states every invoice is recomputable from stored inputs. Dropping those tables destroys the evidence behind recognised revenue (note that the energy is `source = SIMULATED` unless an external system posted readings, see (c) 13). Export them (CSV or a dump via `deploy/backup.sh`) before any drop, and keep the invoices and journals untouched. Whether any real issued SETTLEMENT invoice exists on any server is **not verified**; on the demo server the nightly reset (if the cron is live) recreates only a DRAFT one (2.4).
2. **Shared enums.** `InvoiceType.SETTLEMENT` and `WoOrigin.ALERT` mark existing rows that cannot be changed (issued invoices are statutory documents and must not be retyped; work orders are operational history). Postgres cannot drop an enum value in place and `deploy/MIGRATIONS_AR.md:29` demands converting rows first. A Prisma client generated without a value that a row still holds fails when it reads that row (general Prisma behaviour; not run here), and `finance` reads invoices by type (`invoices.service.ts:837-841`, `reports.service.ts:86,371,441`). Keep both values permanently. `ContractType.PPA`/`OM` are normal contract types (`commercial/dto.ts:15,97`) and Madar extracts them (`customer_contract.ts:50`).
3. **Inline PPA contracts stay.** `Contract` rows with `contractType PPA`, `status ACTIVE`, `totalValue 0` outlive `PpaTerm`; they keep appearing in `/contracts`, on customer pages, in the `activeContracts` KPI (`reference.controller.ts:127`) and in Finance reports (see (c) 1).
4. **Two-release rule and rollback** (4.1): a single-release drop is unsafe.
5. **Tests:** API/web: only `api-smoke.mjs:67` breaks. Copilot: nothing breaks from deleting the NPI screens; tests only break if the copilot module keys or the `ppa_operator` profile are changed (Jest `overlays`, `catalog`, `onboarding-machine`, `settings`; Playwright `settings`, `setup-live`). Copilot Jest and Playwright are not CI gates (`package.json:24`), so a break there would not be caught by CI; they must be run by hand (`npx jest` / `npx playwright test` inside `apps/copilot`, per `CLAUDE.md`).
6. **Seed and demo:** `seed-demo.js` keeps working (steps skip) but leaves the hospital project without readings; a clean script edit is advisable. The demo reset replays all migrations, so the drop migration must apply cleanly on a fresh database after 0006 and 0007 have run (it will, if it only drops what those two created).
7. **Process:** the removal touches `packages/db` schema, endpoint contracts and `apps/web`, which spec E.3 freezes for the Madar tasks; log it as an owner decision (see 4.1 Copilot).

---

## 5. Conclusion (c) — surprising or coupled things you would not expect

1. **Finance's IFRS-15 percentage-of-completion treats every PPA contract as a milestone contract worth 0 (by code reading, not executed).** `ReportsService.poc()` takes every contract with status ACTIVE or CLOSED, whatever its type (`finance/reports.service.ts:78-91`). For an inline PPA contract (`totalValue 0`, no milestones) `recognizedRevenue` is `min(0, 0 || 0) = 0` (`:171`), while `billedRevenue` sums its issued SETTLEMENT invoices (`:173`), so `targetAdjustment = -billed` and the row's position is `CONTRACT_LIABILITY` (`:175,195-196`). The Finance page shows a "recognize" button for any row with `|unpostedDelta| >= 0.01` when the user holds `finance.invoice.write` (`apps/web/src/app/(app)/finance/page.tsx:215-224`), and `POST /finance/reports/poc/:contractId/recognize` (`reports.controller.ts:21-24`) would post Dr Revenue / Cr Contract Liability for the whole settlement revenue (`reports.service.ts:265-271`). `profitability()` also lists these contracts (`:431-447`). The settlement invoice is only DRAFT in seeded data (2.4), so this appears only after a real issue. It is independent of the removal, but hiding the PPA screen leaves nobody watching those contracts, so decide what happens to the inline PPA contracts (close them, or exclude type PPA from `poc()`).
2. **PPA creates "active" contracts outside the normal contract path.** `ppa.service.ts:84-94` writes an ACTIVE contract with no proposal or opportunity, skipping the accepted-revision rule, the DRAFT start and the CRM win hook that `ContractsService.create` enforces (`commercial/contracts.service.ts:66-90,107,119`). These rows inflate `activeContracts` on the dashboard (`reference.controller.ts:127`) and show on customer pages.
3. **FSM depends on a telemetry table without importing the module.** `fsm.service.ts:388-393` writes `PerformanceAlert` directly; `FsmModule` never imports `TelemetryModule`. Conversely telemetry writes `WorkOrder` rows itself (`telemetry.service.ts:165-179`, `:310-323`). A grep for module imports alone would call the two "independent".
4. **Hiding by permission is impossible.** Neither section owns a permission key (1.5, 2.5); the keys gate Work orders, Assets, Invoices and Contracts too. The same flag `canOps = can('fsm.workorder.read')` drives both the Work-orders tile and the telemetry tile on the dashboard (`dashboard/page.tsx:54,156,183`), and the row-2 grid counts the ops block as two tiles (`:132`).
5. **The web app has no route guard.** The sidebar filters by permission, but `/telemetry` and `/ppa` open for any logged-in user (no middleware, `layout.tsx:51-53`). Removing the nav entries is not "blocking".
6. **`seed-demo.js` has a latent bug and is not idempotent for PPA.** `run?.invoiceId` (`seed-demo.js:252`) tests the wrong nesting of `settle`'s `{ run, invoice }` result (`ppa.service.ts:266`), so the demo SETTLEMENT invoice is never issued. Each run also adds another inline PPA contract and term (`docs/crm-phase-1/step-4-agent-report.md:141`). The nightly demo reset (`docker-compose.demo-reset.yml:54`) runs it; failures are swallowed (`seed-demo.js:43-52`).
7. **The copilot's `ppa` and `telemetry` modules are not real NPI permission families.** `discover.ts:132-133` looks for permissions starting with `ppa.` / `telemetry.`, which `permissions.ts:6-77` never defines, so these modules can never be inferred as held; they exist only as Madar configuration (binding spec `02-TECH-SPEC.md:90`, `03-DESIGN-SPEC.md:42`, acceptance AT-11 `06-ACCEPTANCE-TESTS.md:37`). The `ppa_operator` profile lists them as visible, so after a removal Madar's setup and settings screens would still offer two modules that NPI no longer has.
8. **Three telemetry endpoints have no web consumer** (`POST` and `GET /telemetry/readings`, `GET /telemetry/assets/:id/history`), and `POST /telemetry/readings` is documented as the entry point for a separate "integration service" (`telemetry.controller.ts:14`; README W5 note) that is not in this repository (workspaces are `api`, `web`, `copilot`). An external poster on a live server would start receiving 404 after a hide; whether one exists is **not verified**.
9. **A lot of the PPA model is decorative.** `billingCycle` and `endDate` are stored and never used; nothing sets a term to SUSPENDED/ENDED or a run to CANCELLED (2.2). `BILLING_CYCLES`, `PPA_STATUSES` (shared) and `alertStatuses`, `tel.detectedAt`, `ppa.cycle`, `ppa.start` (web) are unused. This simplifies a data-retention decision: every term is ACTIVE and every run INVOICED.
10. **Generic finance code mislabels settlement invoices.** The issue journal memo is hard-coded `Milestone invoice <code>` (`invoices.service.ts:302`) for every invoice type.
11. **Small string mismatches:** the web translates telemetry's "no PLANT asset yet" message (`errors.ts:19`) but PPA's different message "Project has no PLANT asset" (`ppa.service.ts:165`) falls through untranslated. The login screen, the invoices empty-state hint, the role-editor label and the dashboard chip all advertise the sections (1.1, 2.1).
12. **Process facts that affect planning.** Local `main` is 31 commits (the PR #11 merge) behind `origin/main`; code on `origin/main` equals `feat/copilot` except one test file. The root `npm test` runs only the API suite, so a copilot Jest or Playwright break would not fail CI. `.claude/skills/npi-erp-testing/SKILL.md:125,128` hard-codes stale sidebar counts.
13. **Every telemetry reading in this repository is simulated unless something external posted it, and PPA does not care.** `TelemetryReading.source` defaults to `SIMULATED` (`schema.prisma:1795`, `telemetry.service.ts:82,91`); the only producer in the repo is the simulator (`telemetry.service.ts:217-248`, shown on the page with the warning `tel.simulateHint`, `messages.ts:1097,2321`). `settle()` selects readings by asset and date only, with no filter on `source` (`ppa.service.ts:166-168`), so a SETTLEMENT invoice is exactly as real as its readings. Whether any issued SETTLEMENT invoice built on real readings exists anywhere is **not verified**; this is the first thing to ask the owner before deciding between hiding and dropping.

---

## 6. Not verified (explicit)

- Any live data: rows in `PpaTerm`, `SettlementRun`, `PerformanceAlert`, `TelemetryReading`; SETTLEMENT invoices and their journals; work orders with origin ALERT; inline PPA contracts. No server or database was queried.
- The demo server's crontab (the repo docs `deploy/README_AR.md:88` and `deploy/NEXT_DEPLOY_T47_AR.md:41` say a 03:00 reset exists) and live role permission sets (roles are editable).
- Whether any external client posts to `POST /telemetry/readings`.
- Runtime outcomes stated "by code reading": the PoC row and recognise behaviour (finding 1), the `seed-demo.js` result (1.4, 2.4), and Prisma's behaviour on an unknown enum value (4.2).
- Whether Playwright's negated `toBeChecked()` passes on a missing element (`apps/copilot/e2e/settings.spec.ts:96-98`); it matters only if the copilot module keys are removed.
- Contents of `testsprite_tests/**` (names only), `docs/archive/**`, `docs/COPILOT_PROGRESS_ARCHIVE.md`, `PROGRESS.md`, `perf/**`: excluded by instruction.
- No test, lint, typecheck or build was run; the verification list in section 3 is a proposal.

## 7. How this was collected (for reproduction)

`git grep -n -iE "telemetry|\bppa\b|PpaTerm|SettlementRun|PerformanceAlert|TelemetryReading|ALERT_WORKORDER|SETTLEMENT" -- apps packages scripts deploy docs README.md spec .claude ':!docs/archive' ':!docs/COPILOT_PROGRESS_ARCHIVE.md' ':!apps/copilot/src/npi/openapi.json'`; per-file reads of the two API modules, the two pages, `nav.ts`, `layout.tsx`, `dashboard/page.tsx`, `schema.prisma:1585-1910`, migrations `0006`, `0007`, `0009`, `seed.ts`, `seed-demo.js`, `docker-compose.demo-reset.yml`, `invoices.service.ts`, `reports.service.ts`, `permissions.ts`, `enums.ts`; a Python key-listing of `openapi.json` paths; `git diff --stat` and `git rev-list --left-right --count` between `main`, `origin/main`, `feat/copilot` and `feature/crm-phase-1`.
