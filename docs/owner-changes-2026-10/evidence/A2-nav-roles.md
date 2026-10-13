# A2 - Navigation, visibility and roles: evidence report

**Question behind this report.** The owner (Arabic speaker, non-technical) said: «أريد شاشات المستخدمين تعرض فقط الأقسام المفوضين عليها، كي تكون الشاشة أبسط» - each user's screen should show only the sections they are authorised on. This report states exactly how visibility works today, why screens look crowded, and what the smallest correct change is.

- Repo `C:/dev/npi-erp`, branch `feat/copilot`, HEAD `1a4d545`. Strictly read-only: nothing was run (no server, build, test or browser).
- Paths are repo-relative; citations are `file:line` at that HEAD. In tables `Y` = visible / allowed, `-` = not.
- The role x sidebar matrix was computed by a throw-away script (kept in the session scratchpad, not in the repo) that parses `packages/db/prisma/seed.ts` and `apps/web/src/lib/nav.ts`. I recomputed five of the six roles by hand (all except admin) and the counts agree.

### Not verified
- The live demo-server database: which roles really exist there (roles can be created and edited from `/admin`), which role each real user holds, whether any user holds extra roles. Everything below about "seeded roles" is from `seed.ts`, which is NOT run by the deploy script (see 5.2).
- Browser rendering. All UI behaviour is from reading code.
- The company's operating-cycle document (only the six role names given in the brief were used).
- How `/copilot` is proxied in production (it is a separate Next.js app, `apps/web/src/lib/nav.ts:76-78`).

---

## 1. Bottom line

1. **The "show only what you are authorised on" mechanism already exists**, driven by permissions, in four places: the sidebar (`apps/web/src/app/(app)/layout.tsx:119-122`), the Ctrl+K palette (`apps/web/src/components/global-search.tsx:84`), the entity search (server side, `apps/api/src/modules/search/search.service.ts:61-266`) and the dashboard blocks (`apps/web/src/app/(app)/dashboard/page.tsx:51-72`). The API is the real authority and is fail-closed (`apps/api/src/common/guards/permissions.guard.ts:36-43`).
2. **So the crowding is not a missing filter.** It comes from: (i) who is looking - `admin` sees 26 of 26 sidebar items, `executive` 23 of 26, and the "new user" form pre-selects the first role in the list, which is `admin`; (ii) what the other seeded roles may read - 11 to 17 of 26; (iii) coarse keys - five read permissions each open 2 or 3 sidebar items; (iv) four items carry no permission at all; (v) a static dashboard strip shown to everyone.
3. **Nothing is per user.** A user = one primary role + optional extra roles; permissions are the union. There are no per-user overrides. Department and Delegation do not influence what a user sees.
4. **The admin can already create and edit roles** in `/admin` (Arabic screens x actions grid), but there are no presets, and the six company roles are only partly represented (no «المكتب الفني», no «أمين مستودع», no separate finance management).
5. **No page-level guard.** A user who types a URL gets the page frame plus a red «لا تملك صلاحية لتنفيذ هذا الإجراء» card, not a friendly "not enabled for you".
6. **No row-level scoping anywhere.** Every permission is organisation-wide.
7. **A trap for any trimming:** some pages side-load lists under other keys, so a role can see a sidebar item whose page fails to load (confirmed in code for the seeded accountant on `/procurement`, section 9.3).
8. **Smallest correct change** = data first (six role presets, exactly one role per user), then four tiny code edits (section 11b).

---

## 2. Sidebar and command palette (Q1)

| Question | Answer | Evidence |
|---|---|---|
| How does the shell apply `perm`? | `AppLayout` takes `can` from `useAuth()`; for each of the 5 sections it keeps the items where `!i.perm || can(i.perm)`. `can` is exact string membership in `user.permissions` - no wildcard, no admin bypass. `user.permissions` is the sorted union over the primary and all extra roles, returned by `/auth/login` and `/auth/me`. | `apps/web/src/app/(app)/layout.tsx:26,119-121`; `apps/web/src/lib/auth.tsx:85-88`; `apps/api/src/modules/auth/auth.service.ts:19-25,75-94,117-139` |
| Are group headers with zero visible items hidden? | Yes: `if (visible.length === 0) return null`. **But only the three middle groups can ever disappear**: "المبيعات والتعاقد" always holds `/dashboard` (no perm) and "الإدارة" always holds `/inbox`, `/approvals`, `/copilot` (no perm). Among the six seeded roles only `site_engineer` loses a group today (Finance, 0 of 5). | `layout.tsx:122`; `apps/web/src/lib/nav.ts:26,74,75,79` |
| Do items without `perm` always show? | Yes. 4 of 26: `/dashboard`, `/inbox`, `/approvals`, `/copilot`. The type documents it ("omitted = visible to everyone"), and comments give the reasons (self-scoped on the server; every user may open the assistant). | `nav.ts:11-12,71-73,76-78` |
| Does Ctrl+K / global search apply the same filter? | Screen "commands": same filter - `NAV_ITEMS.filter((i) => !i.perm \|\| can(i.perm))`, and `NAV_ITEMS` is the same flattened map as the sidebar. Entity hits: filtered on the server - `/search` is `@SkipPermissions()` but `SearchService` queries each entity only if the caller holds that entity's read key (customers, leads, opportunities, proposals, contracts, invoices, projects, work orders, serial units). The floating search button and the notification bell render for every user. | `global-search.tsx:81-94`; `nav.ts:92`; `apps/api/src/modules/search/search.controller.ts:12-21`; `search.service.ts:55,61,94,124,149,173,197,218,242,266`; `layout.tsx:217-218` |
| Any collapsing, favourites or per-user customisation? | None. `NAV_SECTIONS` is a static constant; the shell's only navigation state is the mobile drawer flag. A search over `apps/web/src` for favourite/pinned/collapse/preferences found only unrelated hits (draft autosave, the auth token). The only per-user UI preference is the language toggle. | `nav.ts:21-89`; `layout.tsx:30,33-49,165-179`; `apps/web/src/lib/useDraft.ts` |
| Is the browser's permission list live? | No. Permissions are fetched once on page load; the API re-reads roles on every request. A role change is enforced by the server at once but the open sidebar updates only after reload or re-login. | `apps/web/src/lib/auth.tsx:44-65`; `apps/api/src/modules/auth/jwt.strategy.ts:102-129` |

Two consequences: (1) the 22 gated items sit on only 16 distinct permission keys (Appendix B) - a role cannot open `/customers` without `/tasks`, `/workorders` without `/telemetry`, `/invoices` without `/ppa`, `/procurement` without `/requisitions`; (2) `/inbox`, `/approvals` and `/tasks` overlap: `/inbox` aggregates approvals (link target `/approvals`), workflow tasks and follow-up tasks (link target `/tasks`) - `apps/api/src/modules/inbox/inbox.service.ts:69-74,99,174`; for a non-manager `/approvals` shows only the same "waiting on me" list - `apps/web/src/app/(app)/approvals/page.tsx:6-9,27-38`.

---

## 3. Dashboard (Q2)

`/dashboard` is the landing page for everybody: `/` redirects to it (`apps/web/src/app/page.tsx:3-4`) and so does login (`apps/web/src/app/login/page.tsx:39`).

**It is already permission-gated, per block.** There is one flag per data source, each equal to the permission its endpoint requires, so a user without the permission never fires the call and never sees the tile (the code comment: rendering the 403 as a dash "makes the system look broken") - `apps/web/src/app/(app)/dashboard/page.tsx:48-64`. Flags and endpoints:

| Flag (`dashboard/page.tsx`) | Permission | Endpoint and its server-side key |
|---|---|---|
| `canCrm` (:51) | `crm.lead.read` | `GET /reference/dashboard` - `apps/api/src/modules/reference/reference.controller.ts:111-114` |
| `canTasks` (:52) | `crm.customer.read` | `GET /tasks/summary` - `apps/api/src/modules/crm/follow-up-tasks.controller.ts:58-60` |
| `canFin` (:53) | `finance.invoice.read` | `GET /finance/summary` - `apps/api/src/modules/finance/invoices.controller.ts:81-85` |
| `canOps` (:54) | `fsm.workorder.read` | `GET /fsm/work-orders/summary` (`apps/api/src/modules/fsm/fsm.controller.ts:37-41`) and `GET /telemetry/dashboard` (`apps/api/src/modules/telemetry/telemetry.controller.ts:57-61`) |

**What a user without the permission sees:** the block is *hidden* (not rendered, not requested) - `dashboard/page.tsx:67-72` (KPI filter), `:91`, `:113`, `:131-133`, `:141`, `:156`, `:183`. It is neither an empty tile nor an error. Two exceptions: a role with no metric source at all gets the explicit hint `dash.noMetrics` («لا توجد مؤشرات تخص دورك…», `apps/web/src/lib/messages.ts:286`) at `:215-219`; and the **static "lead > opportunity > proposal > contract > operate" strip is shown to everyone** (`:221-244`, label `dash.flow` «مسار العمل: من عميل محتمل إلى عقد»).

Per-role result, computed from the seed (`Y` = the block is rendered):

| Dashboard block | Rule in code | admin | executive | accountant | sales | pm | site_engineer |
|---|---|---|---|---|---|---|---|
| Quick-action chips (`quick-actions.tsx:25-39`) | any of 7 write keys (lead, customer, opportunity, work order, PO, vendor payment, invoice) | Y | - | Y | Y | Y | Y |
| "My follow-ups" strip (`dashboard/page.tsx:91-110`) | `crm.customer.read` | Y | Y | Y | Y | Y | - |
| KPI: open leads (`:68`) | `crm.lead.read` | Y | Y | - | Y | - | - |
| KPI: open opportunities (`:69`) | `crm.lead.read` and `crm.opportunity.read` | Y | Y | - | Y | - | - |
| KPI: active contracts (`:70`) | `crm.lead.read` and `commercial.contract.read` | Y | Y | - | Y | - | - |
| KPI: issued invoices (`:71`) | `finance.invoice.read` | Y | Y | Y | Y | Y | - |
| Pipeline value card (`:133-154`) | `crm.lead.read` | Y | Y | - | Y | - | - |
|   receivables + retention inside the pipeline card (`:141-152`) | `crm.lead.read` and `finance.invoice.read` | Y | Y | - | Y | - | - |
| Work-orders card (`:156-181`) | `fsm.workorder.read` | Y | Y | - | - | Y | Y |
| Telemetry card (`:183-211`) | `fsm.workorder.read` | Y | Y | - | - | Y | Y |
| Static "lead > opportunity > proposal > contract > operate" strip (`:221-244`) | none | Y | Y | Y | Y | Y | Y |

Observations:
- A site engineer's dashboard is: one quick-action chip, the work-orders card, the telemetry card and the sales-funnel strip. An accountant's is: three chips, the follow-ups strip, one KPI (issued invoices) and the funnel strip.
- The receivables/retention box is nested inside the pipeline card (`dashboard/page.tsx:133-153`), so the seeded accountant - who holds `finance.invoice.read` - never sees receivables (the card needs `crm.lead.read`). That is a gating defect in the opposite direction (too little, not too much).
- The accountant's chip "new PO" targets `/procurement?new=1`, a page that fails to load for that role (section 9.3).
- Quick actions are gated on the WRITE key of the thing they start (`apps/web/src/components/quick-actions.tsx:25-39`), which is the right design.

---

## 4. Direct URL access to a route the user lacks permission for (Q3)

**There is no page-level guard.** Evidence:
- `(app)/layout.tsx` only redirects unauthenticated visitors to `/login` (`layout.tsx:51-53`); there is no `middleware.*` under `apps/web` (checked at depth 1 and 2); `Providers` contains only i18n, toast and auth (`apps/web/src/components/providers.tsx:16-22`).
- The `perm` values in `nav.ts` are used only to *draw* links (sidebar, palette); nothing maps the current pathname to a permission.

**What happens instead:** the page renders its frame and fires its request; the API answers `403 Insufficient permissions` (`permissions.guard.ts:41-49`; global guard order Throttler, JWT, Permissions: `apps/api/src/app.module.ts:59,61,64`); the page turns that into a red card.
- `/contracts` without `commercial.contract.read`: header, status filter and an empty table stay on screen, plus a red `LoadError` card with «لا تملك صلاحية لتنفيذ هذا الإجراء» and a Retry button - `apps/web/src/app/(app)/contracts/page.tsx:34-38,47,82-83`; message text `apps/web/src/lib/errors.ts:418-423`; card `apps/web/src/components/ui.tsx:632-642`.
- `/admin`, `/departments`, `/delegations`: the whole page is replaced by that card - `apps/web/src/app/(app)/admin/page.tsx:330`, `departments/page.tsx:169`, `delegations/page.tsx:158`.
- `/invoices`, `/procurement`: the card sits above empty tables - `invoices/page.tsx:64`, `procurement/page.tsx:237`.
- The project's own testing skill calls this "a 403 rendered as an error banner", "the recurring defect class on this project" that "has shipped twice" (dashboard, `/ppa`) - `.claude/skills/npi-erp-testing/SKILL.md:127-133`. Some pages were hardened to skip side-loads they cannot read (`apps/web/src/app/(app)/projects/page.tsx:51-55`, `ppa/page.tsx:75-88`).

Security is intact (every list route has `@RequirePermissions` or an explicit `@SkipPermissions`; an undeclared route is denied). The cost is presentation only: read literally, the owner's request also wants a calm "this section is not enabled for your account" instead of a red error.

---

## 5. Roles and the role x sidebar matrix (Q4)

### 5.1 Every seeded role

Roles are rows of the `Role` table with a flat `permissions String[]` (`packages/db/prisma/schema.prisma:301-323`, array at :309). The seed creates exactly six, by `upsert`, in this order:

| Key | Arabic name | English name | Keys | Where the permission set comes from |
|---|---|---|---|---|
| `admin` | مدير النظام | Administrator | 40 (= `ALL_PERMISSIONS`) | list `packages/db/prisma/seed.ts:18-35`; upsert `seed.ts:117-127` (first role created) |
| `sales` | مندوب مبيعات | Sales Representative | 17 | list `seed.ts:37-47`; upsert `seed.ts:129-139` |
| `accountant` | محاسب | Accountant | 17 | list `seed.ts:49-58`; role def `seed.ts:142`; upsert loop `:148-155` |
| `pm` | مدير مشاريع | Project Manager | 16 | list `seed.ts:60-71`; role def `:143` |
| `site_engineer` | مهندس موقع | Site Engineer | 9 | list `seed.ts:86-98`; role def `:144` |
| `executive` | الإدارة العليا | Executive management | 21 (all `*.read` + all `*.approve` + `finance.costs.view`, `admin.audit.read`, `admin.approval.manage`, `crm.customer.merge`; no write, no system admin) | list `seed.ts:73-84`; role def `:145` |

Full key lists (from the seed arrays):

- **admin / مدير النظام** (40 keys): `admin.approval.manage`, `admin.audit.read`, `admin.delegation.manage`, `admin.department.manage`, `admin.org.manage`, `admin.user.manage`, `admin.workflow.manage`, `assets.serialunit.read`, `commercial.contract.read`, `commercial.contract.write`, `commercial.item.read`, `commercial.item.write`, `commercial.proposal.approve`, `commercial.proposal.read`, `commercial.proposal.write`, `crm.customer.merge`, `crm.customer.read`, `crm.customer.write`, `crm.lead.read`, `crm.lead.write`, `crm.opportunity.read`, `crm.opportunity.write`, `finance.costs.view`, `finance.invoice.read`, `finance.invoice.write`, `finance.ledger.read`, `finance.payment.read`, `finance.payment.write`, `finance.period.manage`, `fsm.workorder.read`, `fsm.workorder.write`, `platform.attachment.read`, `platform.attachment.write`, `projects.project.approve`, `projects.project.read`, `projects.project.write`, `scm.procurement.approve`, `scm.procurement.read`, `scm.procurement.write`, `scm.requisition.write`
- **executive / الإدارة العليا** (21 keys): `admin.approval.manage`, `admin.audit.read`, `assets.serialunit.read`, `commercial.contract.read`, `commercial.item.read`, `commercial.proposal.approve`, `commercial.proposal.read`, `crm.customer.merge`, `crm.customer.read`, `crm.lead.read`, `crm.opportunity.read`, `finance.costs.view`, `finance.invoice.read`, `finance.ledger.read`, `finance.payment.read`, `fsm.workorder.read`, `platform.attachment.read`, `projects.project.approve`, `projects.project.read`, `scm.procurement.approve`, `scm.procurement.read`
- **accountant / محاسب** (17 keys): `commercial.contract.read`, `commercial.item.read`, `commercial.proposal.read`, `crm.customer.read`, `finance.costs.view`, `finance.invoice.read`, `finance.invoice.write`, `finance.ledger.read`, `finance.payment.read`, `finance.payment.write`, `finance.period.manage`, `platform.attachment.read`, `platform.attachment.write`, `scm.procurement.approve`, `scm.procurement.read`, `scm.procurement.write`, `scm.requisition.write`
- **sales / مندوب مبيعات** (17 keys): `commercial.contract.read`, `commercial.contract.write`, `commercial.item.read`, `commercial.proposal.read`, `commercial.proposal.write`, `crm.customer.read`, `crm.customer.write`, `crm.lead.read`, `crm.lead.write`, `crm.opportunity.read`, `crm.opportunity.write`, `finance.costs.view`, `finance.invoice.read`, `finance.invoice.write`, `finance.ledger.read`, `platform.attachment.read`, `platform.attachment.write`
- **pm / مدير مشاريع** (16 keys): `assets.serialunit.read`, `commercial.contract.read`, `commercial.item.read`, `crm.customer.read`, `finance.costs.view`, `finance.invoice.read`, `fsm.workorder.read`, `platform.attachment.read`, `platform.attachment.write`, `projects.project.approve`, `projects.project.read`, `projects.project.write`, `scm.procurement.approve`, `scm.procurement.read`, `scm.procurement.write`, `scm.requisition.write`
- **site_engineer / مهندس موقع** (9 keys): `assets.serialunit.read`, `commercial.item.read`, `fsm.workorder.read`, `fsm.workorder.write`, `platform.attachment.read`, `platform.attachment.write`, `projects.project.read`, `scm.procurement.read`, `scm.requisition.write`

Other places that define roles (not the live system): `packages/db/prisma/madar-scratch-orgs.ts:114-138` replicates five of them (no `executive`) for end-to-end scratch organisations; the Madar copilot ships six company "profile packs" with their own `rolePermissionSets` (`apps/copilot/catalog/profiles/*.json`, see section 8). The web shell also carries display labels for two keys that no seed creates, `finance` and `ops` (`apps/web/src/app/(app)/layout.tsx:15-23`) - legacy fallbacks; the server-supplied role name wins (`layout.tsx:192-198`).

Seeded users: six demo logins, one per role (`seed.ts:156-207`). None has a department (no `departmentId` in those rows), and the four seeded departments OPS, ENG, FIN, ADM (`seed.ts:724-738`) have no members.

### 5.2 How a role's set is stored and changed (matters for any "tighten the roles" plan)

- Effective permissions are read from the database on every request (`apps/api/src/modules/auth/jwt.strategy.ts:107-129`), so an edit in `/admin` takes effect on the server immediately.
- `seed.ts` overwrites a seeded role's permissions every time it runs (`update: { permissions: ... }` at `seed.ts:119,131,151`).
- **The deploy script does not run the seed**: it runs `prisma migrate deploy` only (`deploy/deploy.sh:188-190`; no "seed" anywhere in that script). The seed runs only in the destructive demo-reset job, which first wipes the database (`deploy/docker-compose.demo-reset.yml:51-54`).
- Therefore editing the arrays in `seed.ts` changes fresh databases and demo resets only. On the live demo server a role changes only by (a) editing it in `/admin`, or (b) a data migration (precedent: `packages/db/prisma/migrations/0021_crm_roles_permissions/migration.sql:43-65` appended keys with `UPDATE "Role" ... array_append`).

### 5.3 Visible sidebar items per role - counts (the compact matrix)

| Role (key / Arabic) | المبيعات والتعاقد (7) | التنفيذ والتوريد (5) | التشغيل (3) | المالية (5) | الإدارة (6) | Total /26 |
|---|---|---|---|---|---|---|
| admin / مدير النظام | 7 | 5 | 3 | 5 | 6 | **26** |
| executive / الإدارة العليا | 7 | 5 | 3 | 5 | 3 | **23** |
| accountant / محاسب | 5 | 3 | 1 | 5 | 3 | **17** |
| sales / مندوب مبيعات | 7 | 1 | 1 | 4 | 3 | **16** |
| pm / مدير مشاريع | 4 | 5 | 3 | 1 | 3 | **16** |
| site_engineer / مهندس موقع | 1 | 5 | 2 | 0 | 3 | **11** |

### 5.4 Full role x sidebar-item matrix (26 items)

`Y` = the item is drawn for that role (computed from the seed key lists above and the `perm` of each item in `apps/web/src/lib/nav.ts`; the `nav.ts line` column is the item's declaration).

| Sidebar group | Item (Arabic label) | Route | Required read permission | nav.ts line | admin | executive | accountant | sales | pm | site_engineer |
|---|---|---|---|---|---|---|---|---|---|---|
| المبيعات والتعاقد | لوحة المعلومات | `/dashboard` | **none (everyone)** | 26 | Y | Y | Y | Y | Y | Y |
| المبيعات والتعاقد | العملاء المحتملون | `/leads` | `crm.lead.read` | 27 | Y | Y | - | Y | - | - |
| المبيعات والتعاقد | العملاء | `/customers` | `crm.customer.read` | 28 | Y | Y | Y | Y | Y | - |
| المبيعات والتعاقد | الفرص | `/opportunities` | `crm.opportunity.read` | 29 | Y | Y | - | Y | - | - |
| المبيعات والتعاقد | مهام المتابعة | `/tasks` | `crm.customer.read` | 31 | Y | Y | Y | Y | Y | - |
| المبيعات والتعاقد | العروض | `/proposals` | `commercial.proposal.read` | 32 | Y | Y | Y | Y | - | - |
| المبيعات والتعاقد | العقود | `/contracts` | `commercial.contract.read` | 33 | Y | Y | Y | Y | Y | - |
| التنفيذ والتوريد | المشاريع | `/projects` | `projects.project.read` | 40 | Y | Y | - | - | Y | Y |
| التنفيذ والتوريد | طلبات الشراء | `/requisitions` | `scm.procurement.read` | 41 | Y | Y | Y | - | Y | Y |
| التنفيذ والتوريد | المشتريات | `/procurement` | `scm.procurement.read` | 42 | Y | Y | Y | - | Y | Y |
| التنفيذ والتوريد | الأصول المتسلسلة | `/assets` | `assets.serialunit.read` | 43 | Y | Y | - | - | Y | Y |
| التنفيذ والتوريد | الأصناف | `/items` | `commercial.item.read` | 44 | Y | Y | Y | Y | Y | Y |
| التشغيل | التشغيل والصيانة | `/workorders` | `fsm.workorder.read` | 51 | Y | Y | - | - | Y | Y |
| التشغيل | مراقبة المحطات | `/telemetry` | `fsm.workorder.read` | 52 | Y | Y | - | - | Y | Y |
| التشغيل | عقود الطاقة والتسوية | `/ppa` | `finance.invoice.read` | 53 | Y | Y | Y | Y | Y | - |
| المالية | الفواتير | `/invoices` | `finance.invoice.read` | 60 | Y | Y | Y | Y | Y | - |
| المالية | مستحقات الموردين | `/payables` | `finance.payment.read` | 61 | Y | Y | Y | - | - | - |
| المالية | التقارير المالية | `/finance` | `finance.ledger.read` | 62 | Y | Y | Y | Y | - | - |
| المالية | القوائم المالية | `/statements` | `finance.ledger.read` | 63 | Y | Y | Y | Y | - | - |
| المالية | دفتر الأستاذ | `/ledger` | `finance.ledger.read` | 64 | Y | Y | Y | Y | - | - |
| الإدارة | صندوق المهام | `/inbox` | **none (everyone)** | 74 | Y | Y | Y | Y | Y | Y |
| الإدارة | الاعتمادات | `/approvals` | **none (everyone)** | 75 | Y | Y | Y | Y | Y | Y |
| الإدارة | مساعد مَدار | `/copilot` | **none (everyone)** | 79 | Y | Y | Y | Y | Y | Y |
| الإدارة | المستخدمون والأدوار | `/admin` | `admin.user.manage` | 80 | Y | - | - | - | - | - |
| الإدارة | الأقسام | `/departments` | `admin.department.manage` | 85 | Y | - | - | - | - | - |
| الإدارة | التفويضات المؤقتة | `/delegations` | `admin.delegation.manage` | 86 | Y | - | - | - | - | - |
| **Total visible (of 26)** | | | | | **26** | **23** | **17** | **16** | **16** | **11** |

### 5.5 Roles that see almost everything, and why

- **`admin` - 26 of 26.** A pure data grant: the seed gives it all 40 keys (`seed.ts:117-127`). There is no bypass in code: `can()` is a plain `includes` (`apps/web/src/lib/auth.tsx:85-88`) and the API guard checks the same list (`permissions.guard.ts:45-50`). No wildcard syntax exists anywhere (searched `apps/api`, `apps/web`, `packages/shared`).
- **`executive` - 23 of 26.** By design (oversight): every `*.read`, every `*.approve`, costs, audit log and approval matrix (`seed.ts:73-84`). Only the three admin screens are hidden. It holds no write key, so the person can approve but cannot create or edit anything, yet sees ledger, payables, telemetry, assets and so on.
- **Union of roles.** Any user with extra roles gets the union (`jwt.strategy.ts:117-126`); the "new user" and "edit user" forms offer extra roles as a checkbox list (`apps/web/src/app/(app)/admin/page.tsx:694-714`).
- **The default role of a new user is `admin`.** The create-user modal pre-selects `roles[0]` (`admin/page.tsx:232`) with no empty "choose a role" option (`:672-692`); `roles` come from `GET /admin/roles` ordered by `createdAt` ascending (`apps/api/src/modules/admin/admin.service.ts:275-281`), and `admin` is the first role the seed creates (`seed.ts:117`). Unless the person creating the user changes the dropdown, the new user is a full administrator. (Order on the live DB not verified; `admin` is first in any seeded database.)
- **The mid roles are broad on purpose**, per their own seed comments: accountant "all the money + read of its context" (`seed.ts:49`); pm "full delivery and supply + read of contracts, operations and invoicing" (`seed.ts:60`); site engineer gets `scm.procurement.read` because the requisitions list needs it (`seed.ts:91-93`, `apps/api/src/modules/procurement/requisitions.controller.ts:29-30`). `sales` holds `finance.ledger.read`, `finance.invoice.read/write` with no explanatory comment (`seed.ts:44`) - that alone puts three accounting screens, invoices and PPA in a salesperson's sidebar.

### 5.6 What-if (computed from the matrix; illustrations, not recommendations)

| Change to a seeded role | Sidebar items before -> after | Items that disappear |
|---|---|---|
| sales without `finance.ledger.read` | 16 -> 13 | `/finance`, `/statements`, `/ledger` |
| sales without `finance.ledger.read` and `finance.invoice.read` | 16 -> 11 | the three above + `/invoices`, `/ppa` |
| pm without `finance.invoice.read` | 16 -> 14 | `/invoices`, `/ppa` |
| accountant without `crm.customer.read` | 17 -> 15 | `/customers`, `/tasks` |
| site_engineer without `scm.procurement.read` | 11 -> 9 | `/procurement`, `/requisitions` (the key exists for requisitions) |

Removing `*.approve` keys is NOT cosmetic: deciding an approval step requires the document's approve key in the caller's own permissions (`apps/api/src/common/approval.service.ts:322-325`).

---

## 6. Assignment model: user, role, department, delegation (Q5)

**User to role.** One required primary role plus any number of extra roles; effective permissions are the union.
- Schema: `User.roleId` required (`schema.prisma:334-335`), `User.extraRoles` (`:360`), join table `UserRole` with unique (userId, roleId) (`:375-385`).
- Runtime: `jwt.strategy.ts:117-126`, `auth.service.ts:19-25`.
- Admin API and forms: `CreateUserDto.roleId` + `extraRoleIds` (`apps/api/src/modules/admin/dto.ts:33-41`), `UpdateUserDto` (`:59-68`), form `admin/page.tsx:672-714`; the primary cannot also be an extra (`admin.service.ts:92-109`).
- Lockout guard: the organisation must always keep an active user who can manage users (`admin.service.ts:183-197,258-271,326-356`).

**Per-user permission overrides: none.** `User` has no permission column (`schema.prisma:325-371`); the token carries no permission list and `JwtStrategy` builds the set from roles only (`jwt.strategy.ts:107-129`); the admin DTOs have no permission field for users (`dto.ts:16-77`). A different set for one person means a different role (or an extra role).

**Department** (`schema.prisma:2533-2555`: code, Arabic/English name, parent, manager, members through `User.departmentId` at `:338-339`).
- It exists only to scope approval rules and attribute requisitions: a rule may be organisation-wide or department-specific and the department one wins (`approval.service.ts:257-285`); the gate uses the submitter's department (`:180-191`); requisitions store it (`apps/api/src/modules/procurement/requisitions.service.ts:148,160`); proposals route approval by the submitter's department (`apps/api/src/modules/commercial/proposals.service.ts:204-205,531-545`). The schema comment says the same (`schema.prisma:2530-2532`; UI text `dept.hint`, `apps/web/src/lib/messages.ts:1172-1173`).
- It does **not** drive visibility or authorisation: `departmentId` appears in no list query and no guard (grep over `apps/api/src`: only the files above plus the admin CRUD). Membership is edited from the Departments screen (`departments.service.ts:179-227`), not from the user form (no `departmentId` in `dto.ts`).
- The sidebar item that opens this screen is also called «الأقسام» (`messages.ts:1168`) - a source of ambiguity in the owner's sentence (section 11c).

**Delegation** (`ApprovalDelegation`, `schema.prisma:2557-2579`; admin screen `/delegations` behind `admin.delegation.manage`).
- It lends the delegator's **primary role** (`roleId: r.fromUser.roleId`, `apps/api/src/common/delegation.service.ts:56-62`) for approval steps only, inside a time window, never chained (`:12-29`; schema comment `schema.prisma:2557-2560`: "never grants a permission the delegator lacks").
- It is read in exactly two places: the delegate's approvals inbox (`approval.service.ts:443-445`) and the decision check (`:326-338`). Even then the delegate must already hold the document's approve key in their own permissions (`:322-325`).
- It does not touch `/auth/me`, the JWT strategy, the sidebar, the dashboard or any read permission. **A delegation gives the delegate extra rows in `/approvals` and `/inbox`, never extra screens.**

---

## 7. Admin UI: can an admin create roles and edit their permissions? (Q6)

**Yes - already, from `/admin`** (sidebar item behind `admin.user.manage`, `nav.ts:80`).

- Tabs: users and roles always; approval matrix, organisation, audit log, customer merge, loss reasons appear only with their own key (`apps/web/src/app/(app)/admin/page.tsx:354-370`).
- Roles tab: list with Arabic name, key, number of users, number of permissions (`admin/page.tsx:587-601`); "new role", edit and delete (`:292-328`).
- API: `POST /admin/roles` (key must be a lowercase slug, Arabic name required, English optional, at least one permission - `apps/api/src/modules/admin/admin.controller.ts:59-63`, `admin.service.ts:292-318`, `dto.ts:85-106`); `PATCH /admin/roles/:id` edits names and permissions, **never the key** (`admin.service.ts:320-378`, `dto.ts:108-124`); `DELETE` is refused if users hold the role, if the approval matrix uses it, or if it ever signed an approval (`admin.service.ts:380-414`).
- **Permission list presentation:** yes, per section and in Arabic. The catalog `PERMISSION_CATALOG` (`packages/shared/src/permissions.ts:135-188`) is served by `GET /admin/permissions` (`admin.controller.ts:18-23`); the role editor groups it in sidebar order («المبيعات والتعاقد», «التنفيذ والتوريد», «التشغيل», «المالية», «المنصة», «الإدارة»), with one row per screen and three columns «عرض / إنشاء وتعديل / اعتماد», a group-level checkbox, select-all / clear-all, and a separate «صلاحيات خاصة» list for keys that do not fit a column (`admin/page.tsx:203-224,791-889`; labels `apps/web/src/lib/messages.ts:660-666`). Appendix A reproduces the catalog.
- The save button is disabled with zero permissions (`admin/page.tsx:893`); the server also rejects an empty list (`dto.ts:102-105`).

**What it does not offer (all verified absent):**
- No presets / templates / "copy from role" (no such code in `admin/page.tsx`; a search for preset, template, clone, duplicate returned nothing). A new role means ticking boxes from zero.
- No preview of "what will this role's sidebar look like". The grid rows are not the sidebar items: e.g. one row «أوامر العمل والمراقبة» opens both `/workorders` and `/telemetry`; there is no row for `/ppa` (opened by the invoices key), `/tasks` (customers key) or `/requisitions` (procurement read); the admin screens appear only as plain checkboxes in the special list.
- No per-user permission editing (section 6).
- No safe default for a new user's role (section 5.5).

---

## 8. The six company roles versus the seeded roles (Q7)

The six names come from the brief (the company's operating-cycle document was not read).

| Company role | Closest seeded role | Fit | Mismatches (with evidence) |
|---|---|---|---|
| المدير العام (General Manager) | `executive` «الإدارة العليا» | Close | Name differs. Read + approve only, no write keys (`seed.ts:73-84`), so a GM could approve but not edit. Sees 23 of 26 items. The default PROPOSAL approval chain is wired to `executive` (`seed.ts:692`), so rename it in place rather than replacing it. `admin` is a system role, not a GM. |
| الإدارة المالية (Finance) | `accountant` «محاسب» | Partial | There is no finance-manager level distinct from the accountant; web labels mention a `finance` role (`layout.tsx:21`) that no seed creates. The accountant also holds procurement write + approve (`seed.ts:56`) and period closing (`seed.ts:52`), and is the second signer on PO and progress-claim chains (`seed.ts:686-687`). |
| مدير عام المشاريع (Projects GM) | `pm` «مدير مشاريع» | Partial | Seeded `pm` is the project-manager level: first signer for requisitions, POs, claims and change orders (`seed.ts:685-688`); has no `commercial.proposal.read`; does read invoices and PPA (`seed.ts:69`). A "general manager of projects" may need oversight rather than data entry - an owner decision. |
| مهندس مشاريع (Project engineer) | `site_engineer` «مهندس موقع» | Partial | The seeded role is a field role (work orders, assets, requisitions, no money, no contracts: `seed.ts:86-98`) and is named "site". An office project engineer who maintains projects or reads contracts/customers has no seeded role. The Madar pack `engineer` (`apps/copilot/catalog/profiles/engineering_consulting.json:41`) is closer but is not in the seed. |
| المكتب الفني (Technical office) | none | Missing | Nearest is that Madar pack `engineer` (12 sidebar items). Note `commercial.item.write` is held only by `admin` in the seed (`seed.ts:22`, absent from every other list), so nobody except the administrator can maintain the item catalogue / BOM items today. |
| محاسب أو أمين مستودع (Accountant or storekeeper) | `accountant` for the accountant half; nothing for the storekeeper | Partial / missing | One company label covers two different permission profiles. The Madar pack `warehouse_keeper` (`apps/copilot/catalog/profiles/equipment_trading.json:57`; 7 keys, 8 sidebar items) is not in the seed - and, as built, it would break two of its own pages (section 9.3). |

Seeded roles that are **not** on the company's list: `sales` «مندوب مبيعات» and `admin` «مدير النظام». Whether the company has a salesperson role at all is a question for the owner (the six listed roles contain no sales or CRM role).

Constraints when creating or renaming roles:
- `Role.key` is permanent (`UpdateRoleDto` has no `key`, `dto.ts:108-124`); display names are free to change.
- A role referenced by the approval matrix cannot be deleted (`admin.service.ts:392-403`); the seeded chains use `pm`, `accountant`, `admin` and `executive` (`seed.ts:685-692`). So rename in place; re-point chains from `/admin` > approval matrix if a new role should sign.
- The copilot has dedicated personas for five keys only (`admin`, `sales`, `pm`, `accountant`, `site_engineer`, `apps/copilot/src/positions/persona.ts:11`); any other key (including `executive` and every new role) gets the default persona.
- Role presets already exist as data in the Madar onboarding: the six profile packs (`apps/copilot/catalog/profiles/*.json`: `rolePermissionSets`, `defaultDepartments`, `approvalRuleDefaults`) are planned and applied to NPI through the admin API (`apps/copilot/src/onboarding/plan.ts:369-439`, `apply.ts:173-185`). That machinery could carry the six company roles, but the packs have drifted from the seed: `pm` lacks `finance.costs.view`, `projects.project.approve`, `scm.procurement.approve`; `accountant` lacks `finance.costs.view`, `scm.procurement.approve`; `sales` lacks `finance.costs.view` (compare `epc.json:24-99` with `seed.ts:37-71`).

---

## 9. Inside the pages: are buttons and tabs gated? (Q8)

### 9.1 Three sample pages

| Page | Action controls and their gates | Tabs |
|---|---|---|
| **Contracts** list `apps/web/src/app/(app)/contracts/page.tsx` | Read-only: the only control is a "details" link (:93-97); nothing to gate. | none |
| Contracts detail `contracts/[id]/page.tsx` | "Activate" inside `<Can perm="commercial.contract.write">` (:109); per-milestone "verify" needs `commercial.contract.write` (:173); "generate invoice" needs `finance.invoice.write` (:184) - the comment explains verifying is a contract right and invoicing a finance right. | none |
| **Procurement** list `procurement/page.tsx` | "New vendor" and "New PO" inside `<Can perm="scm.procurement.write">` (:227-234); stock "transfer" gated (:327-331). The PO table (:239), the vendors block (:282) and the stock block (:323) all sit behind the one read key. | none |
| Procurement detail `procurement/[id]/page.tsx` | "Approve" and "Receive" (:157-168) and per-receipt "Create bill" (:274) inside `<Can perm="scm.procurement.write">`. A read-only role (site engineer) sees no buttons there (`.claude/skills/npi-erp-testing/SKILL.md:143-144`). | none |
| **Invoices** list `invoices/page.tsx` | Read-only; the only control is the "details" link (:117). | none |
| Invoices detail `invoices/[id]/page.tsx` | "Issue" and "Credit note" inside `<Can perm="finance.invoice.write">` (:160-170); `canPay` requires `finance.invoice.write` (:143-144, the comment stresses it is NOT `finance.payment.write`); retention release gated (:318). | pay / credit / files - static, not permission-dependent (:342-350) |

### 9.2 What the pattern is, and where it leaks

- Gating is by **hiding**: `Can` renders nothing when a key is missing (`apps/web/src/components/ui.tsx:196-211`); its documented rule is to pass the permission the button's endpoint requires, which is not always the page's key. The server still refuses regardless.
- **Ungated write button:** `/requisitions` shows "new requisition" to everyone who can open the page (`apps/web/src/app/(app)/requisitions/page.tsx:118`), but creating needs `scm.requisition.write` (`apps/api/src/modules/procurement/requisitions.controller.ts:50-51`) while the page itself needs only `scm.procurement.read` (`:29-30`). The seeded `executive` has the read key but not the write key, so it sees the button and gets a 403 on save.
- Requisition **detail** buttons are server-driven: the engine filters the workflow transitions by the caller's live permissions (`requisitions/[id]/page.tsx:3-11`) - the best pattern in the codebase.
- Tabs gated by permission: `/admin` (`admin/page.tsx:354-370`), the `/approvals` history tab (`approvals/page.tsx:27-38`), and the customer 360 view, where the **server** omits sections the caller cannot read (opportunities, proposals, contracts, projects, and subcontractor claims which need procurement read plus costs view: `apps/api/src/modules/crm/customers.service.ts:343-346,394,422,449,477,503-506`) and the page draws only the tabs that came back (`customers/[id]/page.tsx:218-228`). Invoice, project and work-order detail tabs are static (`projects/[id]/page.tsx:328-337`).
- Pages with neither `can(` nor `<Can>`: contracts, invoices and proposals lists, `/ledger`, both requisitions pages, `/departments`, `/delegations`, the invoice print page. Lists and reports are read-only; the two admin pages are wholly behind their keys.

### 9.3 Sidebar item visible, page cannot load (latent "403 banner" cases)

The sidebar gates on ONE read key per page, but several pages also load lists that need OTHER keys. Scanning every `api.get` in `apps/web/src/app/(app)/**/page.tsx` against the controllers' `@RequirePermissions` gives:

| Page (sidebar key) | First-load requests and the key each needs | Failure mode | Who hits it |
|---|---|---|---|
| `/procurement` (`scm.procurement.read`) | vendors, purchase orders, stock, locations: `scm.procurement.read`; `/items`: `commercial.item.read`; `/projects`: `projects.project.read` - all inside one `Promise.all` (`procurement/page.tsx:85-101`) | all-or-nothing: one 403 shows the red card and none of the tables fill | **seeded `accountant`** (has `commercial.item.read`, lacks `projects.project.read`); also the Madar `warehouse_keeper` pack |
| `/opportunities` (`crm.opportunity.read`) | `/opportunities` + `/customers` (`crm.customer.read`) in one `Promise.all` (`opportunities/page.tsx:54-59`) | all-or-nothing | no seeded role (every holder also has customer.read); a "technical office" style role would hit it |
| `/assets` (`assets.serialunit.read`) | serial units; `/procurement/locations` (`scm.procurement.read`); `/fsm/warranty-claims` (`fsm.workorder.read`) (`assets/page.tsx:68-78`) | separate requests; any failure raises the banner while the rest still shows | no seeded role; Madar `warehouse_keeper` (no `fsm.workorder.read`) |
| `/telemetry` (`fsm.workorder.read`) | dashboard, alerts; `/projects` (`projects.project.read`) (`telemetry/page.tsx:55-57`) | banner | none seeded |
| `/workorders` (`fsm.workorder.read`) | list, summary, technicians, plans; `/fsm/assets` (`assets.serialunit.read`) (`workorders/page.tsx:94-98`) | banner | none seeded |
| `/workorders/[id]` | adds `/items` (`commercial.item.read`) and `/procurement/locations` (`scm.procurement.read`) (`workorders/[id]/page.tsx:113-116`) | banner | none seeded |
| `/ppa`, `/projects`, `/projects/[id]`, `/tasks`, `/dashboard` | side-loads already guarded by `can()` or swallowed | none | - |

So for the six seeded roles there is one confirmed visible-but-broken screen: the accountant on `/procurement`, which also breaks the accountant's "new PO" dashboard chip (`apps/web/src/components/quick-actions.tsx:30`). It was found by code reading only and not reproduced in a browser. It matters for the owner's request because **narrowing or creating roles (storekeeper, technical office) will surface exactly this class of failure** unless those pages tolerate a missing side-load the way `/ppa` and `/projects` already do (`ppa/page.tsx:75-88`, `projects/page.tsx:51-62`).

Incidental defect found on the way (not about visibility): the item picker of the "new requisition" modal calls `GET /commercial/items` (`apps/web/src/app/(app)/requisitions/page.tsx:82`), but the API exposes `GET /items` (`apps/api/src/modules/commercial/items.controller.ts:18-24`) and has no `commercial/items` controller (the prefixes there are contracts, items, proposals). The 404 is swallowed by the page's own catch handler (it sets an empty list), so the picker is empty for every role. Not verified in a browser.

---

## 10. Per-record scoping (Q9)

**None.** Every permission is organisation-wide; the only filter on records is the tenant (`organizationId`).
- Lists filter on `organizationId` and optional UI filters only: contracts (`apps/api/src/modules/commercial/contracts.service.ts:25-34`), leads (`apps/api/src/modules/crm/leads.service.ts:50-62`), opportunities (`apps/api/src/modules/crm/opportunities.service.ts:95-111`), projects (`apps/api/src/modules/projects/projects.service.ts:44-59`), work orders (`apps/api/src/modules/fsm/fsm.service.ts:89-99`), requisitions (`apps/api/src/modules/procurement/requisitions.service.ts:83-100`), and every branch of the search (`search.service.ts`).
- Ownership columns exist but never scope a query: `Lead.ownerId` (`schema.prisma:540`) and `Opportunity.ownerId` are stamped at creation (`leads.service.ts:104,221`; `opportunities.service.ts:181`); `WorkOrder.assignedToId` is used for assignment only (`fsm.service.ts:148,181-199`); `Project.projectManagerId` (`schema.prisma:1221`) has no reference at all in `apps/api`, `apps/web` or `packages/shared`.
- The only self-scoped data: follow-up tasks with `mine=1` and the dashboard task summary (`apps/api/src/modules/crm/follow-up-tasks.service.ts:98,149`), the approvals inbox scoped by the caller's roles (`approval.service.ts:443-455`), the unified inbox (`inbox.service.ts:69-74`) and notifications. The tasks screen even offers a "team" scope that lists everyone's tasks (`apps/web/src/app/(app)/tasks/page.tsx:20,46`).
- Masking exists at **field** level, not row level: a user without `finance.costs.view` receives `null` in every cost or margin key of every response (`apps/api/src/common/cost-redaction.interceptor.ts:36-40`, registered globally at `apps/api/src/app.module.ts:69`, key list `packages/shared/src/permissions.ts:199-242`).

Consequence: a project engineer sees all projects, a salesperson all customers. "Each user sees only their own projects or customers" would be a new feature, not a configuration.

---

## 11. Conclusions

### (a) Why a typical non-admin user sees more than they need

Ordered by how much of the clutter each cause explains.

1. **The seeded roles are broad "context-read" bundles** (by their own comments): sales 16 of 26, pm 16, accountant 17, site engineer 11 (section 5.3). A salesperson gets three accounting screens, invoices and PPA through `finance.ledger.read` and `finance.invoice.*` (`seed.ts:44`); the accountant gets customers, tasks, proposals, contracts, items and the whole procurement area (`seed.ts:49-58`); the project manager gets invoices, PPA, customers and contracts (`seed.ts:60-71`); the site engineer gets purchase orders, vendors and stock because the same key reads requisitions (`seed.ts:91-93`).
2. **One read key opens several screens**, so a role cannot be narrowed screen by screen: customers + tasks, requisitions + procurement, work orders + telemetry, invoices + PPA, and three ledger screens (Appendix B; `nav.ts:28,31,41,42,51,52,53,60,62-64`).
3. **Four sidebar items have no permission at all** - dashboard, inbox, approvals, assistant (`nav.ts:26,74,75,79`) - and they pin two group headers on for everyone (`layout.tsx:122`). `/inbox` already lists what `/approvals` and `/tasks` show (`inbox.service.ts:69-74,99,174`).
4. **The dashboard still shows a static sales-funnel strip to every role** (`dashboard/page.tsx:221-244`), and the follow-ups strip to anyone with `crm.customer.read` (accountant, project manager).
5. **People are probably parked in broad roles.** New users default to `admin` (`admin/page.tsx:232`), extra roles add up (`jwt.strategy.ts:117-126`), the role editor has no presets (section 7) and the company's own roles are not represented (section 8): المكتب الفني, أمين مستودع, finance management. Live data not verified.
6. **The viewer may be an administrator.** `admin` sees 26 of 26 and `executive` 23 of 26; if the owner judged the screen while signed in as one of them it will always look crowded, whatever the filter. Hypothesis, to be confirmed with the owner (section 11c).
7. Related but not a clutter cause: on a direct URL the user gets a red error card (section 4), and a few screens are visible but cannot load (section 9.3).

### (b) The smallest set of changes that makes the sentence true

Role-based reading of the sentence ("everyone in a role sees only the screens that role needs"). The mechanism exists; what is missing is correct role data plus four small code edits.

| Candidate | Exists today? | What it takes | Effect | Risk / dependency | Verdict |
|---|---|---|---|---|---|
| Hide empty groups | Yes (`layout.tsx:121-122`), but two groups can never be empty | Put the 4 no-permission items into their own first block in `nav.ts`; the shell already drops empty groups. About 12 lines, 1 file | "Administration" header disappears for 5 roles, "Sales" header for the site engineer; no item removed | Very low | **Do** (makes the rule true; cosmetic) |
| Gate dashboard cards | Done for 9 of 10 blocks | Wrap the funnel strip (`dashboard/page.tsx:221-244`) in `canCrm`; optionally move receivables out of the pipeline card (`:133-153`). About 5 lines | Removes one irrelevant card from 3 roles (accountant, pm, site engineer); accountant gains receivables | Low | **Do** |
| Tighten role seeds | Seeds exist but are not run on deploy (`deploy.sh:188-190`) and re-seeding overwrites role edits (`seed.ts:119,131,151`) | For the live server: edit roles in `/admin` (no code) or ship a data migration (precedent 0021). Keep `seed.ts` and the Madar packs in step (they already drifted, section 8) | Largest lever: each removed read key hides 1 to 3 items (5.6) | Medium: removing a read key can break pages that side-load it (9.3); removing an approve key blocks signing (`approval.service.ts:322-325`) | **Do, as data**, after the 9.3 fix |
| Role presets for the six company roles | Role CRUD yes; templates no; Madar can apply packs (`onboarding/apply.ts:173-185`) | Owner decides six permission sets; create via `/admin`, or add to seed + migration, or author a Madar pack. Rename seeded keys in place (matrix and persona depend on keys) | Direct match to the owner's wording; e.g. storekeeper 8 items, technical office about 12 (Madar `engineer`) | Low to medium: role keys are permanent (`dto.ts:108-124`); pages must tolerate missing side-loads (9.3) | **Do - this is the real answer** |
| Landing page per role | No (`app/page.tsx:3-4`, `login/page.tsx:39`) | About 5 lines | Small: the dashboard already adapts; only a role with no metric source sees the hint | Low | Skip for now |
| Friendly "not enabled for you" guard (new) | No | In `(app)/layout.tsx`, match the pathname against `NAV_ITEMS` and render a calm notice when the item's key is missing. About 15 lines + 2 strings | No clutter change; removes the "403 as error banner" class on direct URLs | Low | Optional, cheap |
| Make the new-user form choose a role (new) | Default is the first role, `admin` (`admin/page.tsx:232`) | Empty disabled first option; the select is already `required` (`:675`). About 4 lines | Stops accidental full administrators | Very low | **Do** |
| Make multi-key pages tolerant (new) | `/ppa`, `/projects` already are | Apply the same `can()` gating to `/procurement` (and `/opportunities`, `/telemetry`, `/assets`, `/workorders`). About 15 lines per page | Fixes accountant on `/procurement`; prerequisite for storekeeper / technical-office roles | Low | **Do before narrowing roles** |
| Split shared read keys (new) | No | New keys + backfill migration like 0021 + catalog + role editor | Only matters if e.g. telemetry must be hidden from work-order readers | Medium to high | Not now |
| Per-person section choice (new) | No model | New column/table + UI + auth payload | Needed only if "per person, not per role" is meant | High | Do not start before (c) |

**Recommended minimal package**
1. *Data, no code:* define the six company roles (rename `executive` to «المدير العام» in place, trim `sales` / `pm` / `accountant` extras the owner does not want, add the missing roles) in `/admin`, and give every user exactly one role and no extra roles.
2. *Four tiny code edits:* regroup the four no-permission items in `nav.ts`; gate the dashboard funnel strip; stop pre-selecting `admin` in the new-user form; make `/procurement` (then the other multi-key pages) tolerant of a missing side-load.
3. *Optional:* the friendly no-access notice; a "sidebar preview" in the role editor (reuse `NAV_ITEMS` and the same `can()` rule) so a non-technical owner sees the effect of each tick.

Not needed for the sentence as written: row-level scoping, splitting permission keys, per-user overrides, department-driven visibility.

### (c) Ambiguities in the owner's sentence

«أريد شاشات المستخدمين تعرض فقط الأقسام المفوضين عليها، كي تكون الشاشة أبسط»

1. **«الأقسام»** can mean four different things in this system, and each leads to a different change:
   - the **sidebar groups** (المبيعات والتعاقد, التنفيذ والتوريد, التشغيل, المالية, الإدارة) - called "sections" in code (`nav.ts:15,21-89`);
   - individual **screens** (العملاء, الفواتير...) - governed by role permissions, today's mechanism;
   - parts **inside** a screen (tabs, cards, columns) - partly done (customer tabs, cost columns), otherwise separate work;
   - the **Department records** («الأقسام» screen: OPS, ENG, FIN, ADM; `messages.ts:1168-1173`) - these only route approvals and have no link to what a user sees (section 6); making them drive visibility would be a new feature.
2. **«المفوضين عليها»** ("authorised on them"): in this system «تفويض» is the **temporary delegation** feature («التفويضات المؤقتة»), which grants no screens (section 6). The owner most likely means "has permission to". Is that decided by **role** (every accountant sees the same - today's model) or **per person** (no such model exists)?
3. **Whose screen?** As `admin` (26 of 26) or `ceo` (23 of 26) the screen is crowded by definition. Which user, with which role, looked crowded?
4. **How simple?** Sidebar only, or also the dashboard and the fields inside screens? Hide only, or also block typed URLs (the server already blocks them)?

**Single question worth asking** (covers 1 and 2; question 3 is the cheapest to check in parallel by signing in as the accountant and the site engineer and comparing):

«حين تقول "الأقسام"، هل تقصد مجموعات القائمة الجانبية (المبيعات والتعاقد، التنفيذ والتوريد، التشغيل، المالية، الإدارة)، أم الأقسام الإدارية الموجودة في شاشة "الأقسام"؟ وهل يتحدد ما يراه كل موظف بحسب دوره الوظيفي (كل المحاسبين يرون الشيء نفسه) أم بحسب كل شخص على حدة؟»

---

## Appendix A - The permission catalog as the role editor shows it (Arabic, per section)

Source: `packages/shared/src/permissions.ts:135-188` (served by `GET /admin/permissions`, drawn by `apps/web/src/app/(app)/admin/page.tsx:203-224,791-889`). Rows are screens of the role editor, not sidebar items.

| Group (sidebar order) | Screen row in the role editor | عرض (view) | إنشاء وتعديل (write) | اعتماد (approve) |
|---|---|---|---|---|
| المبيعات والتعاقد | العملاء المحتملون | crm.lead.read | crm.lead.write |  |
| المبيعات والتعاقد | العملاء | crm.customer.read | crm.customer.write |  |
| المبيعات والتعاقد | الفرص | crm.opportunity.read | crm.opportunity.write |  |
| المبيعات والتعاقد | عروض الأسعار | commercial.proposal.read | commercial.proposal.write | commercial.proposal.approve |
| المبيعات والتعاقد | العقود | commercial.contract.read | commercial.contract.write |  |
| المبيعات والتعاقد | الأصناف | commercial.item.read | commercial.item.write |  |
| التنفيذ والتوريد | المشاريع | projects.project.read | projects.project.write | projects.project.approve |
| التنفيذ والتوريد | المشتريات والمخزون | scm.procurement.read | scm.procurement.write | scm.procurement.approve |
| التنفيذ والتوريد | طلبات الشراء |  | scm.requisition.write |  |
| التنفيذ والتوريد | الأصول المتسلسلة | assets.serialunit.read |  |  |
| التشغيل | أوامر العمل والمراقبة | fsm.workorder.read | fsm.workorder.write |  |
| المالية | الفواتير | finance.invoice.read | finance.invoice.write |  |
| المالية | مستحقات الموردين | finance.payment.read | finance.payment.write |  |
| المالية | دفتر الأستاذ والتقارير | finance.ledger.read |  |  |
| الإدارة | سجل التدقيق | admin.audit.read |  |  |

"Special" keys (listed under «صلاحيات خاصة», not in the grid):

| Group | Key | Arabic label |
|---|---|---|
| المبيعات والتعاقد | crm.customer.merge | دمج العملاء المكررين |
| المالية | finance.period.manage | إدارة الفترات المالية والإقفال |
| المالية | finance.costs.view | عرض التكاليف والهوامش |
| المنصة | platform.attachment.read | عرض المرفقات |
| المنصة | platform.attachment.write | رفع وحذف المرفقات |
| الإدارة | admin.user.manage | إدارة المستخدمين والأدوار |
| الإدارة | admin.org.manage | إعدادات المنشأة |
| الإدارة | admin.approval.manage | ضبط مصفوفة الاعتماد |
| الإدارة | admin.department.manage | إدارة الأقسام |
| الإدارة | admin.delegation.manage | إدارة التفويض المؤقت |
| الإدارة | admin.workflow.manage | مراقبة سير العمل والأحداث |

## Appendix B - Permission keys that open more than one sidebar item

| Read key | Sidebar items it opens | Other effects |
|---|---|---|
| `crm.customer.read` | `/customers`, `/tasks` (`nav.ts:28,31`) | dashboard follow-ups strip; reads follow-up task list |
| `scm.procurement.read` | `/requisitions`, `/procurement` (`nav.ts:41,42`) | reads POs, vendors, stock, locations, subcontracts (`procurement.controller.ts`) |
| `fsm.workorder.read` | `/workorders`, `/telemetry` (`nav.ts:51,52`) | dashboard work-orders and telemetry cards |
| `finance.invoice.read` | `/ppa`, `/invoices` (`nav.ts:53,60`) | dashboard issued-invoices KPI; `/ppa` API also uses it (`apps/api/src/modules/ppa/ppa.controller.ts:14-15,33-34`) |
| `finance.ledger.read` | `/finance`, `/statements`, `/ledger` (`nav.ts:62-64`) | all financial reports |
| every other gated item | exactly one (`/leads`, `/opportunities`, `/proposals`, `/contracts`, `/projects`, `/assets`, `/items`, `/payables`, `/admin`, `/departments`, `/delegations`) | - |

## Appendix C - How the numbers were produced

- Role key lists: `packages/db/prisma/seed.ts:18-98` (arrays parsed as text; `EXECUTIVE_PERMISSIONS` re-derived by the same rule as `seed.ts:75-84`).
- Sidebar items and their `perm`: `apps/web/src/lib/nav.ts:21-89`. A role sees an item when `perm` is absent or in its list - the exact rule at `layout.tsx:121`.
- Dashboard blocks: rules in `dashboard/page.tsx:51-72,91,113,131-213,221-244` and `quick-actions.tsx:25-39`.
- Endpoint keys for the page scan: `@RequirePermissions` on the 207 routes found under `apps/api/src/**/*.controller.ts`.
- Nothing in the repository was modified; scripts and fragments live in the session scratchpad only.
