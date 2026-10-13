# A5 - Execution and finance half of the operating cycle: gap analysis

Scope: requirements E1-E14 (everything after the contract is signed) against the code in `C:\dev\npi-erp`
(branch `feat/copilot`, HEAD `1a4d545` at session start). `apps/copilot` ignored, as instructed.
Method: read-only. Schema, services, controllers, DTOs, seed, and the web pages were read; nothing was run
(no servers, tests, builds, git writes). Files on the do-not-read list were not opened.

Evidence convention: `path:line` relative to the repo root. `schema` = `packages/db/prisma/schema.prisma`,
`seed` = `packages/db/prisma/seed.ts`, `shared` = `packages/shared/src`.
"Web reach" claims come from grepping every `api.get/post/patch` call in `apps/web/src` - they say "no screen
calls this endpoint", not "the screen was exercised". Items marked **(code-read)** are conclusions from reading
code paths that I did not execute.

---------------------------------------------------------------------------------------------------------

## 0. Scorecard

| Req | Topic | Status | One-line gap (business terms) |
|---|---|---|---|
| E1 | Assign project engineer + time plan | **PARTIAL (leans MISSING)** | The Projects GM cannot name a site engineer on a project, and there is no per-budget-line schedule; a plan can only be uploaded as a file. |
| E2 | Material request (buy OR transfer), approved by Projects GM | **PARTIAL** | Purchase requisitions with a banded approval chain exist; a "transfer from warehouse" request does not, and the web form cannot carry a project or budget line. |
| E3 | Stock check, then PO sent to supplier after GM approval | **PARTIAL** | Stock balances are viewable and PO approval is configurable, but nothing checks stock automatically, the GM is not in the default chain, and there is no "send to supplier" screen or printable PO. |
| E4 | Receiving: warehouse GRN / direct site receipt / transfers+returns | **PARTIAL** | Warehouse GRN works at API level only; direct-to-site receipt with Projects GM approval is absent; transfers are instant single-line moves with no document, and returns have no flow. |
| E5 | Daily execution record, cumulative view, % per budget line, overrun alerts and block | **MISSING** | No daily log, no quantities per activity, no photos/headcount record, no % complete per line, no alert or hard block. |
| E6 | Cost follow-up vs budget per line | **PARTIAL** | A budget/committed/actual/variance table exists per project, but at <=7 category buckets, fed by only 4 cost sources, with no petty cash and with sent POs missing from "committed". |
| E7 | Progress billing and collection | **PARTIAL** | Milestone-to-invoice-to-payment chain with retention exists; it is not tied to field progress, milestones cannot be amended, advance % is unused, there is no cash-flow schedule or ageing. |
| E8 | Supplier payment request (advance/partial vs quotation or invoice) | **MISSING** | Payments exist only against approved bills/claims; no request document, no quotation, no advance, no signature chain. |
| E9 | Petty cash / custody and settlement | **MISSING** | Nothing at all (no model, route, screen, or GL account). |
| E10 | Handover form, acceptance and commissioning report, closing | **MISSING** | Project "CLOSED" is a bare stage click with no gating; handover form and acceptance report do not exist; retention release is a manual button. |
| E11 | Item master with units; warehouse/stock ledger | **PARTIAL** | Item master EXISTS (free-text unit); a basic stock ledger EXISTS, but site locations cannot be created, receipts ignore the chosen location, and there is no issue-to-project, return, count, or valuation. |
| E12 | Warranties per contract/component; suspension on overdue payment | **MISSING** | Only serial-level RMA claims exist; no warranty terms, no start-at-acceptance, no overdue concept (invoices have no due date). |
| E13 | Change orders with price and time impact | **EXISTS (with gaps)** | Works for price (contract value and budget move on approval); time impact is stored but moves no date; no reject path; extra value cannot be billed. |
| E14 | Internal approvals on the execution side | **PARTIAL** | Matrix covers 5 document types (requisition, PO, subcontractor claim, change order, proposal); receipts, payments, overruns, petty cash, handover are outside it; seeded roles do not match the company's six. |

---------------------------------------------------------------------------------------------------------

## 1. Cross-cutting facts that decide many requirements

### 1.1 What a project budget actually is

- `Project` holds no budget. `Project.contractId` is unique (1:1 with the contract) (schema:1207-1245).
- The budget is `WbsElement` rows: `code`, `nameAr`, `nameEn`, **one `budgetAmount` number**, and a `parentWbsId`
  that nothing uses (schema:1248-1268). There is no quantity, unit, unit price, or schedule on a budget line.
- Rows are created in exactly one place: `ProjectsService.createFromContract` (apps/api/src/modules/projects/projects.service.ts:67-146).
  It sums `BomLine.qty x Item.unitCost` (the catalogue cost, not the selling price) per `ItemCategory` of the accepted
  proposal revision (L89-95), mapped to seven fixed buckets PV/INV/MNT/ELE/BOS/SPR/SRV (L19-27, L116-126).
  A contract with no proposal revision gets one `GEN` bucket with budget 0 (L125).
- There is no endpoint or screen to add, rename, delete or re-price a budget line. The only later change is
  `budgetAmount += delta` when a change order that names a line is approved (projects.service.ts:347-352).
  Controller surface is list/get/create/stage/change-orders/approve only (projects.controller.ts:14-52).
- Consequence: the owner's "Estimated budget / مقايسة" (about 18 catalogue lines with unit, quantity, price, total)
  has no home. The proposal-side `BomLine` (item, qty, unitPrice, unitCost: schema:744-770) holds line-level detail,
  but it is flattened to category sums when the project is created, so the line structure is lost.

### 1.2 Which documents carry a project and a budget line (as stored)

| Document | Project | Budget line | Evidence |
|---|---|---|---|
| Purchase requisition | optional header `projectId` | optional per line `wbsElementId` | schema:2610-2611, 2638-2639 |
| Purchase order | optional header `projectId` | optional per line `wbsElementId` | schema:1278, 1307 |
| Goods receipt / line | none (via PO) | none (via PO line) | schema:1320-1366 |
| Stock movement | none | none | schema:1567-1587 |
| Project cost entry (actuals) | required | optional `wbsElementId` | schema:1401-1418 |
| Project commitment | required | optional | schema:2658-2674 |
| Subcontract agreement | required | optional (validated against project) | schema:1476-1498; procurement.service.ts:1148-1153 |
| Change order | optional | optional (validated) | schema:1451-1473; projects.service.ts:260-265 |
| Vendor bill / vendor payment | via PO only / none | none / none | schema:1988-2054 |
| Timesheet / work-order part | via work order | none (cost entries written without a line) | fsm.service.ts:295-305, 464-474 |
| Petty cash, daily log, handover | do not exist | - | - |

Requisition and PO lines accept any `wbsElementId` without checking it belongs to the document's project
(requisitions.service.ts:643-674 `priceLines`; procurement.service.ts:195-201). Only subcontracts and change orders validate it.

### 1.3 Company roles vs seeded roles (seed.ts:117-160)

| Company role | Closest seeded role | What it can do today |
|---|---|---|
| المدير العام (GM) | `executive` "الإدارة العليا" | All `*.read` and `*.approve` keys, no `*.write` (seed.ts:75-84). In the default matrix only for proposals. |
| مدير عام المشاريع | `pm` "مدير مشاريع" | projects write+approve, procurement write+approve, requisition write (seed.ts:61-71). Default signer for PR, PO, claim, change order. |
| الإدارة المالية / محاسب | `accountant` | all finance, procurement write+approve (seed.ts:50-58). |
| مهندس مشاريع | `site_engineer` | work orders read/write, requisition write, projects **read only**, no `finance.costs.view` (seed.ts:88-98). |
| المكتب الفني | none | would need a new role. |
| أمين مستودع | none | no storekeeper role; stock operations sit under `scm.procurement.write`. |

Roles are data (create/patch/delete via `/admin/roles`, admin.controller.ts:53-75), so the six company roles can be defined
without code. Permissions are coarse module keys (shared/permissions.ts:6-77): there is no key for "approve a receipt",
"approve a payment request", "approve a budget overrun", or "approve petty cash".

### 1.4 Reachability from the web (API exists vs a screen calls it)

Web calls into procurement are only: vendors (list/create), purchase-orders (list/get/create/approve/receive), bills (create only),
stock, locations, transfers, serial-units (list/install), subcontracts (create/claims/approve claim)
(grep of `apps/web/src`; lines in procurement/page.tsx, procurement/[id]/page.tsx, assets/page.tsx, projects/[id]/page.tsx).

API-only (no screen calls them):
- `POST /procurement/purchase-orders/:id/send` (procurement.controller.ts:61-66)
- `POST /procurement/receipts/:id/inspect|accept|reject` (procurement.controller.ts:74-104)
- `POST /procurement/bills/:id/match|approve|schedule` (procurement.controller.ts:113-142)
- `POST /requisitions/:id/convert` (requisitions.controller.ts:83-92)

Effect: from the screens, a PO can be created and approved, a receipt can be recorded (it stays DRAFT), and a bill can be
requested from a receipt - but the bill call requires an ACCEPTED receipt (procurement.service.ts:734), which no screen can produce,
and receiving requires status SENT (procurement.service.ts:427) while the PO page offers Receive for APPROVED
(procurement/[id]/page.tsx:146) and offers no Send. So the procure-to-pay chain beyond "approve PO" is not completable from the UI **(code-read)**.

### 1.5 Fields that exist but are never used (stubs)

| Field | Declared | Usage found |
|---|---|---|
| `Project.projectManagerId` | schema:1221 (plain string, no relation) | none in apps/api or apps/web |
| `Project.plannedStart / plannedEnd` | schema:1219-1220 | accepted by DTO and saved at creation (projects/dto.ts:11-12; projects.service.ts:114-115); web never sends or shows them |
| `Contract.advancePct` | schema:792 | written at creation only (contracts.service.ts:124) |
| `RetentionEntry.releaseDueDate` | schema:1022 | never written or read |
| `Asset.warrantyEndDate` | schema:1662 | never written or read |
| `WbsElement.parentWbsId` | schema:1252 | none |
| `ChangeOrderStatus.REJECTED` | schema:1425 | no endpoint sets it |
| `CostType.EQUIPMENT / OVERHEAD` | schema:1081-1087 | no writer |
| `ReceiveDto.locationId` | procurement/dto.ts:63-64 | sent by the web (procurement/[id]/page.tsx:126), read by nobody |
| `Location.projectId`, types SITE / VAN | schema:1538, 1442-1447 | no code creates a Location except the seed |
| `ContractStatus.SUSPENDED / CLOSED` | schema:138-144 | only `ACTIVE` is ever written (contracts.service.ts:162) |

---------------------------------------------------------------------------------------------------------

## 2. Requirement-by-requirement

### E1 - Assign a project engineer and attach a time plan (Projects GM)  ->  PARTIAL (leans MISSING)

What exists
- `Project.projectManagerId String?` is a bare string with no relation to `User` (schema:1221).
- `plannedStart` / `plannedEnd` exist on `Project` (schema:1219-1220) and the create DTO accepts them (projects/dto.ts:11-12).
- A plan document can be uploaded to the project: `AttachmentEntity.PROJECT` (schema:2149), web Files tab (projects/[id]/page.tsx:629),
  extension whitelist includes pdf/xlsx/docx/dwg/png/jpg (attachments.service.ts:25-28), 10 MB limit (L20).
- The natural Projects-GM role has `projects.project.write` (seed.ts:61-71).

Gap
- Nothing sets or shows the engineer: the field is read/written nowhere in apps/api or apps/web; `CreateProjectDto` has no such member
  (projects/dto.ts:5-13); `createFromContract` ignores it (projects.service.ts:103-127); there is no update endpoint (projects.controller.ts:14-52).
  The web "new project" modal sends only `{contractId}` (projects/page.tsx:76, 165-188).
- No "my projects" for an engineer: `list()` filters only by organization (projects.service.ts:44-59) and the seeded engineer role can read all projects.
- The time plan is not structured: `WbsElement` has no start/end/weight (schema:1248-1257), so there is nothing to compare actuals against; planned dates are never shown.
- Business effect: the Projects GM cannot record who runs a site, an engineer has no scoped workspace, and a schedule per budget line cannot be tracked.

### E2 - Material request: purchase or warehouse transfer, approved by Projects GM  ->  PARTIAL

What exists
- `PurchaseRequisition` (+ lines: item, qty, estimated unit price, optional budget line) with header project and department
  (schema:2600-2646); web list and detail screens (requisitions/page.tsx, requisitions/[id]/page.tsx).
- Flow DRAFT -> PENDING_APPROVAL -> APPROVED -> CONVERTED/REJECTED/RETURNED (seed.ts:766-791); approval-matrix document type
  `PURCHASE_REQUISITION` banded on estimated total and optionally department (shared/approvals.ts:36-46; approval.service.ts:257-296).
  Default band: >= 10,000 SAR -> chain `[pm]` (seed.ts:685).
- Separation of duties: engineer holds `scm.requisition.write` only (seed.ts:88-98, shared/permissions.ts:47-51); requester cannot approve own
  request (requisitions.service.ts:307-309; approval.service.ts:339-341).
- Through the API a requisition's project and budget lines flow into the PO on conversion (requisitions.service.ts:552-581).

Gaps
- **No "transfer" request type.** The requisition has no type, source location or destination location (schema:2600-2630). Moving stock is
  `POST /procurement/transfers` (procurement.controller.ts:182-186): immediate, no request, no approval (procurement.service.ts:1371-1457).
- **Budget line / project cannot be chosen in the web form**: payload is justification, neededBy, lines(item, qty, price) only
  (requisitions/page.tsx:91-101). Server also does not verify a supplied `wbsElementId` belongs to the project (requisitions.service.ts:643-674).
- **Item picker likely empty (code-read)**: the form calls `/commercial/items` (requisitions/page.tsx:82); the controller is `@Controller('items')`
  (apps/api/src/modules/commercial/items.controller.ts:18) with global prefix `api` only (apps/api/src/main.ts:18), so the route does not exist.
- **Small requests (code-read)**: with no matching band, "submit" is also "approve" (requisitions.service.ts:399-415) and the engine requires
  `scm.procurement.approve` of the submitter (workflow.engine.ts:369). The seeded engineer lacks it, so requests under 10,000 SAR cannot be filed by an
  engineer under the default configuration.
- **Convert button trap (code-read)**: the detail page renders every engine-available action, including CONVERT (seed.ts:789). It posts to
  `/requisitions/:id/actions`, which only flips the status to CONVERTED (requisitions.service.ts:262-283) and creates no PO and no `purchaseOrderId`.
  Real conversion (`/requisitions/:id/convert`) has no screen.
- Business effect: engineers can ask to buy, but cannot ask for stock from the warehouse; the budget line is not captured from the screen.

### E3 - Stock check, then formal PO after General Manager approval  ->  PARTIAL

What exists
- Balances by location: `GET /procurement/stock` (procurement.controller.ts:176-180; service L1359-1368) and a stock table on `/procurement`
  (procurement/page.tsx:323-363). Only non-serialised items live in `StockLevel` (procurement.service.ts:596-628); serialised stock is the
  `serial-units?state=IN_STOCK` list on the assets screen.
- PO lifecycle DRAFT -> PENDING_APPROVAL -> APPROVED -> SENT -> PARTIALLY_RECEIVED/RECEIVED -> CLOSED (schema:1052-1061; seed.ts:797-820).
  Matrix type `PURCHASE_ORDER` on total incl. VAT (shared/approvals.ts:47-54). Sending is legal only from APPROVED (seed.ts:812; procurement.service.ts:376-394)
  and goods can only be received once SENT (procurement.service.ts:427).
- The matrix can name `executive` (the GM role) as a signer: a role only needs to hold `scm.procurement.approve` and have an active user
  (approvals.service.ts:212-255), and `executive` holds every `*.approve` key (seed.ts:75-84). A band from 0 upward would force GM sign-off on every PO.

Gaps
- Default chain is `[pm, accountant]` from 100,000 SAR (seed.ts:686); below that, anyone with `scm.procurement.approve` approves alone
  (procurement.service.ts:281-285). The GM is not in the default PO chain.
- The stock check is manual: neither `createPo` nor `convertToPo` reads `StockLevel` (procurement.service.ts:172-245; requisitions.service.ts:532-609);
  no reservation, no "available" figure, no hint that a requested item is already in the warehouse.
- "Formal PO sent to the supplier": there is no printable/PDF/e-mailed PO (the only print route in the web is the tax invoice: apps/web/src/app/(app)/invoices/[id]/print/page.tsx),
  and no screen calls `send` (see 1.4). The PO page also shows Receive for APPROVED POs (procurement/[id]/page.tsx:146), which the server refuses.
- The web PO form captures vendor + optional project + lines (item, qty, price) but **no budget line per line** (procurement/page.tsx:40, 206-210), so commitments/actuals from UI-made POs land in "unallocated".
- Business effect: Finance must eyeball balances, and the GM-before-send rule depends on matrix configuration plus API use.

### E4 - Receiving: warehouse GRN, direct site receipt, transfers and returns  ->  PARTIAL

(a) Warehouse receipt «إذن إضافة مستودعي» - API EXISTS, UI incomplete
- `GoodsReceipt` DRAFT -> INSPECTED -> ACCEPTED / PARTIALLY_REJECTED (schema:1066-1071, 1320-1349; seed.ts:822-838); lines = PO line, qty, serials, batch (schema:1351-1366).
  Acceptance creates serial units, raises stock, writes a movement and a MATERIAL cost entry (procurement.service.ts:558-695).
- Stored on the receipt: PO (required, schema:1325), `receivedAt` (defaults to now - the DTO has no date: procurement/dto.ts:59-65), `receivedById`, `inspectedAt/ById`, `rejectionNote`, `notes`.
- Not stored: receipt location, a user-entered date, a budget line (only through the PO line), who accepted (only in workflow history), signatures, any printable form.
- A receipt without a PO is impossible (`purchaseOrderId` required), so owner-supplied or returned goods have no entry document.
- **Location ignored**: `ReceiveDto.locationId` (procurement/dto.ts:63-64) is sent by the web (procurement/[id]/page.tsx:126, selector L296-303) but `receive()` (procurement.service.ts:416-503)
  and `acceptGrn()` never read it; acceptance always uses the first `WAREHOUSE` location by code (L569-573).
- No screen calls inspect/accept/reject (see 1.4), so a UI-made receipt stays DRAFT: no stock, no cost, no bill **(code-read)**.

(b) Direct receipt at project site with Projects GM approval, charged to the project budget - MISSING
- The GRN flow has no approval step (single permission `scm.procurement.write` on every transition: seed.ts:833-837) and `GRN` is not an approval-matrix type (shared/approvals.ts:12-18).
- No site location can be created (only `WH-MAIN` and `YARD-1` exist via seed, seed.ts:503-513; no code creates `Location` rows - grep).
- Cost is charged to the project at acceptance only if the PO carries a `projectId` (procurement.service.ts:646-659) and to a budget line only if the PO line has one (L651).
  A PO with no project (general stock) charges nothing, and nothing later charges the project when stock is moved to it.
- "Received item serves more than one project -> general receipt location": not modelled; closest is a PO without a project.

(c) Transfers between sites, returns to warehouse - PARTIAL
- `transfer()` moves one serial unit or one item/qty between two locations, instantly (procurement.service.ts:1371-1457); UI: bulk non-serialised only on `/procurement`
  (procurement/page.tsx:365-402), serial moves on `/assets` (assets/page.tsx:104).
- The paper transfer form (source, destination, date, lines item/unit/qty/budget line, signatures) has no equivalent: no header document, no date input
  (`movedAt` defaults to now, schema:1583), no budget line or project on the movement (schema:1567-1587), no approval, no print.
- Returns to the warehouse: no flow. `SerialState.RETURNED` is set only by RMA replacement (fsm.service.ts:654-657).
- Transfers never re-charge project cost.

Business effect: the warehouse-in step works for a PO-backed delivery at API level; everything about "where it landed", "who approved a site receipt",
"which budget line it hit", and "moving stock between sites" is not controllable by the user.

### E5 - Daily execution record linked to budget lines  ->  MISSING

Evidence of absence
- No model: the schema has no daily-log, activity-quantity, site-photo or headcount entity (schema model list; the only "progress" artefacts are
  `ContractMilestone` PROGRESS trigger label (schema:146-150) and subcontractor `ProgressClaim` (schema:1501-1527)).
- No route (full controller list: projects.controller.ts:14-52 is the whole project surface) and no screen (web nav section "التنفيذ والتوريد" lists only projects, requisitions, procurement, assets, items: apps/web/src/lib/nav.ts:36-46).
- `WbsElement` has no quantity (schema:1248-1257), so there is nothing to compute % complete per line against.
- Alerts/blocks: no overrun logic anywhere (grep for overrun/exceed-budget in apps/api returns nothing; `createPo`/`createRequisition` do not look at budgets:
  procurement.service.ts:172-245, requisitions.service.ts:145-194). `BUDGET_OVERRUN` is not an approval document type (shared/approvals.ts:12-18).
- The only "progress" number is certified milestone value / contract value (reports.service.ts:163-172) - unrelated to field quantities.

Nearest building blocks
- `Timesheet` = hours x rate per system user per work order, via `POST /fsm/work-orders/:id/time` (schema:1968-1985; fsm.service.ts:438-489), producing a LABOUR cost entry **without a budget line** (L463-475).
  Work orders cannot be given a project from the web form (workorders/page.tsx:111-118). Construction crews that are not system users cannot be recorded.
- Project-level file upload could hold photos but not tied to a day/activity (attachments.service.ts:25-28).
- Seeded engineer lacks `finance.costs.view`, so any budget figure would be nulled for the person who needs the alert (shared/permissions.ts:199-241; seed.ts:88-98).

Business effect: no daily site record, no quantity progress, no early warning, no gate on overspend.

### E6 - Cost follow-up against the budget  ->  PARTIAL

What exists
- `ProjectsService.get` returns, per budget line and in total: budget, committed, actual, variance (projects.service.ts:152-249), rendered on the project page
  (projects/[id]/page.tsx:283-377), hidden for users without `finance.costs.view` (shared/permissions.ts:199-241; page L109).
- Actuals = append-only `ProjectCostEntry` (schema:1401-1418) with exactly four writers:
  GRN acceptance (MATERIAL, procurement.service.ts:646-659), subcontractor claim approval (SUBCONTRACT, L1303-1314),
  work-order parts (MATERIAL, fsm.service.ts:294-306), work-order time (LABOUR, fsm.service.ts:463-475).
- Contract-level estimate vs actual: `profitability` (reports.service.ts:431-496).
- The GL carries a project dimension (`JournalEntry.projectId`, schema:981); vendor-bill approval posts Dr WIP (procurement.service.ts:920-933).

Gaps
- Granularity: <= 7 category buckets, auto-built from catalogue cost of the BOM, one number each (see 1.1); budget lines cannot be edited or added.
- Missing sources: petty cash (E9); equipment/overhead cost types have no writer; labour/parts entries carry no budget line, so they sit in "unallocated" and appear
  only in totals (projects.service.ts:203-207, 220); UI-made POs carry no budget line (E3).
- **Committed excludes sent POs**: only APPROVED and PARTIALLY_RECEIVED POs count (projects.service.ts:195), yet POs are SENT before receipt (seed.ts:812; procurement.service.ts:427).
  `ProjectCommitment` rows are written (procurement.service.ts:987-1010) but never read for reporting (grep).
- Two cost clocks: actual cost is recognised at receipt acceptance at PO price (L644-659) while the ledger WIP debit happens later at bill approval (L920-933).
- No budget-vs-actual export/print, no alert (E5), no quantity budget.
- Business effect: a rough, category-level job-cost view that under-reports commitments and omits several of the owner's cost sources.

### E7 - Progress billing («مستخلصات/دفعات») and collection  ->  PARTIAL

What exists
- `Contract` with `retentionPct`, `advancePct` and `ContractMilestone` rows (amount, dueDate, triggerType DATE/PROGRESS/EVENT, status PENDING/VERIFIED/INVOICED) (schema:772-827).
- Manual verify (contracts.controller.ts:45-53; contracts.service.ts:182-230) -> draft tax invoice with 15% VAT and retention withheld
  (invoices.service.ts:126-202) -> issue with ZATCA e-invoice and journal (L209+) -> customer payments Dr Bank / Cr AR (L602-684) -> retention release (L690-762) -> credit notes (L364+).
  IFRS-15 progress/revenue recognition from certified milestones (reports.service.ts:78-204). Screens: contracts/[id]/page.tsx:142-208, invoices/[id]/page.tsx.

Gaps
- Field progress is not an input: verifying a milestone is a click by someone with `commercial.contract.write`; nothing links it to project execution, and a PROGRESS trigger has no threshold field (schema:808-827).
- Only pre-agreed milestone amounts can be billed. Milestones cannot be added or edited after creation (contracts.controller.ts:21-53 has no such route), so value added by a change order
  (projects.service.ts:342-345) has no billing route. `advancePct` is stored but nothing bills an advance (grep: only contracts.service.ts:124).
- No collection plan: `Invoice` has no due date or payment-terms field (schema:865-906); the milestone `dueDate` is not shown (web interface declares it, table omits it: contracts/[id]/page.tsx:23, 149-154);
  grep finds no cash-flow, forecast, ageing, or collection report anywhere in apps/api or apps/web.
- Naming trap: in this code base «مستخلص»/`ProgressClaim` is the **subcontractor** claim on the payables side (schema:1501-1527; web 'sub.*' strings), not the customer billing document the owner means.
- Business effect: Finance can bill agreed milestones and record receipts, but cannot bill by measured progress, cannot follow collections against a schedule, and cannot bill a variation.

### E8 - Supplier payment request («طلب صرف دفعة للموردين»)  ->  MISSING (payment execution exists)

What exists
- `VendorPayment` + `VendorPaymentAllocation` (schema:2018-2054); `PayablesService.pay` settles open approved bills or approved subcontractor claims (payables.service.ts:153-252);
  screen payables/page.tsx:88-108. Bill lifecycle record -> three-way match -> approve (posts Dr WIP + VAT input / Cr AP) -> schedule -> pay (seed.ts:839-862; procurement.service.ts:720-971) - but only
  "create bill" has a screen (procurement/[id]/page.tsx:135-142).

Gaps
- No request document with supplier, quotation/invoice no. and date, amount, description, date, and signatures of engineer / projects manager / GM. Vendor payments and bill approval need only
  `finance.payment.write` (procurement.controller.ts:123-142; payables.controller.ts:28-32); no payment type exists in the approval matrix (shared/approvals.ts:12-18).
- No advance or partial payment against a **quotation**: `pay()` rejects anything that is not an open approved bill/claim (payables.service.ts:162-172); there is no quotation entity.
- A bill is built from a receipt at PO prices; only `vendorRef` text can be typed (procurement/dto.ts:68-71; procurement.service.ts:740-761) - no supplier invoice date or amount - and the "billed value" used in the
  match is that same computed subtotal (L821), so the match cannot detect a different supplier invoice.
- Payment date cannot be set (`paymentDate @default(now())`, schema:2025; `PayVendorDto` finance/dto.ts:40-57).
- No supplier-advance GL purpose (schema:2062-2077) and no way to attach the signed form/quotation to a PO, receipt, bill or payment (`AttachmentEntity`, schema:2146-2155).
- Business effect: Finance can pay what has been received and approved; it cannot process or approve a request to pay a supplier in advance or against a quote.

### E9 - Petty cash / custody («عهدة», استعاضة / تسوية)  ->  MISSING

- No model, route or screen (grep for petty/custody/عهدة/استعاضة across schema, apps/api, apps/web, packages returns nothing).
- No cash-on-hand/custody account: seeded chart has Bank only (seed.ts:279-300) and `PostingPurpose` has no cash/custody value (schema:2062-2077); `PaymentMethod.CASH` is just a method label (schema:1916-1920).
- Needs (not present): custodian, custody advance, settlement lines (description, amount, invoice no., project, budget line), technical-office -> projects-manager -> GM chain, GL posting, and cost entries into the job-cost ledger (E6).
- Business effect: all site petty spend is outside the system and outside job costing.

### E10 - Handover, acceptance and commissioning report, closing  ->  MISSING

- Stage flow PLANNING -> PROCUREMENT -> EXECUTION -> COMMISSIONING -> CLOSED (schema:1033-1039; shared/enums.ts:148-182). `setStage` only requires "forward by one"
  (projects.service.ts:373-403): no check for open POs, unreceived goods, unbilled milestones, unreleased retention, or any document. Web: "next stage" button (projects/[id]/page.tsx:241-249, 271-277).
- Closing a project does not close the contract: nothing ever writes `ContractStatus.CLOSED` (contracts.service.ts and projects.service.ts: only ACTIVE and totalValue are written).
- No handover form (customer-facing listing of project data/components with any retained payment) and no acceptance report (8 checklist items, test readings voltage/current/frequency, non-material remarks with remediation deadline, result).
- Nearest building blocks: `WorkOrder.woType = COMMISSIONING` with `checklistJson [{label, done, note}]` (schema:1612-1618, 1700-1701), but checklist templates come only from `MaintenancePlan`
  (fsm.service.ts:328-350; fsm/dto.ts:58-62), there are no numeric readings/deadlines/result/sign-off, and the work-order form cannot set a project (workorders/page.tsx:111-118).
  The serial/asset registry knows installed components per project (procurement.service.ts:1464-1542) and could feed a handover list.
- Retained payment: `RetentionEntry` per invoice (schema:1008-1029), manual release button on the invoice (invoices/[id]/page.tsx:318-332; invoices.service.ts:690-762); `releaseDueDate` unused.
  Acceptance does not trigger "final payment becomes due" or "warranties start".
- Signed paper could be uploaded to the project/contract Files tab (AttachmentEntity.PROJECT/CONTRACT) but as an unstructured file.
- Business effect: handover and closing are unrecorded, ungated events; the money and warranty consequences of acceptance have no trigger.

### E11 - Item master with units; warehouse/stock ledger  ->  PARTIAL

Item master - EXISTS
- `Item`: sku, nameAr/nameEn, `itemCategory` (MODULE, INVERTER, MOUNTING, CABLE, BOS, SPARE, SERVICE), `uom` free string default "unit", `isSerialised`, `unitCost` (schema:94-102, 623-647).
  CRUD API (items.controller.ts:18-43) and screen with a free-text unit field (items/page.tsx:132-156). DTO accepts any string for `uom` (commercial/dto.ts:24, 33).
- The owner's units «عدد» and «م ط» can be typed as text; there is no unit table, conversion, or validation. No battery category (a lithium battery would be BOS/SPARE).
  Requisition/PO/receipt lines have no unit of their own; they inherit `Item.uom` (schema:1301-1317, 2632-2646).
- Seed catalogue is 5 sample items with units unit/m/set (seed.ts:264-269); the owner's materials and 18 budget work items are not loaded.

Stock ledger - EXISTS in basic form
- `Location` (WAREHOUSE / LAYDOWN_YARD / SITE / VAN, optional `projectId`) (schema:1442-1447, 1530-1549); `StockLevel` item x location qty, non-serialised only (schema:1552-1564);
  `StockMovement` RECEIPT / TRANSFER / ISSUE with from/to/qty/source (schema:1567-1587).
- API: locations, stock, transfers (procurement.controller.ts:169-186); receipts add stock (procurement.service.ts:610-641); ISSUE exists only for O&M work-order parts (fsm.service.ts:252-293) and RMA replacement (L673-684);
  guard against transferring more than the source holds (procurement.service.ts:1419-1423). UI: stock table + transfer modal (procurement/page.tsx:323-402).

Gaps (what a user cannot do)
- Create a site/project location (no endpoint; only the seed creates `Location`, seed.ts:503-513) - so "sites as stock locations" is a data-model capability with no way to use it.
- Receive into a chosen location (E4); issue stock to a project or budget line (no issue endpoint; the work-order path writes cost without a line); return to warehouse; stock count or adjustment.
- Serialised items are not in `StockLevel` (their location lives on `SerialUnit.locationId`, procurement.service.ts:596-609), so a single "balance per item" view needs two sources.
- No valuation: `StockLevel` is quantity only and the chart has no inventory account (schema:1552-1564, 2062-2077); no reorder levels or reservations; movements carry no project, budget line or user-entered date.

### E12 - Warranties  ->  MISSING

- No warranty terms on `Contract` (schema:772-806) or any component table. `Asset.warrantyEndDate` exists (schema:1662) and is never written or read (grep).
- `WarrantyClaim` is a serial-unit RMA to the manufacturer with replace flow (schema:1924-1947; fsm.service.ts:507-557, 636-707; assets/page.tsx:271-379); it does not check any warranty period.
- No acceptance event to start a clock (E10), and no overdue concept to suspend one: `Invoice` has no due date (schema:865-906); `PaymentReceipt` is per invoice (schema:1950-1965).
- Business effect: warranty periods per component (panel product/performance, inverter, structures, workmanship) live in the paper contract only.

### E13 - Change orders with price and time impact  ->  EXISTS (with gaps)

What exists
- `ChangeOrder`: signed `amountDelta`, `scheduleImpactDays`, optional budget line, status DRAFT/APPROVED/REJECTED (schema:1451-1473). Create and approve endpoints (projects.controller.ts:38-52).
- Approval-matrix type `CHANGE_ORDER` banded on the absolute delta (shared/approvals.ts:63-70; projects.service.ts:302-323); default band >= 100,000 SAR -> `[pm, admin]` (seed.ts:688).
- On approval: contract value += delta and the named budget line += delta (projects.service.ts:330-371). Screen: projects/[id]/page.tsx:482-533, modal L632-661.

Gaps
- Time impact is informational: approval changes neither `plannedEnd`, contract `endDate`, nor milestone due dates (projects.service.ts:342-356).
- No reject path: `REJECTED` exists but no endpoint sets it and no rejecter is registered (projects.service.ts:39-41), so a rejected chain leaves the change order in DRAFT.
- Single lump amount (no priced line build-up), no customer acceptance or signature, and no way to bill the added value (E7).

### E14 - Internal approvals on the execution side  ->  PARTIAL

What the engine covers
- Five document types: PURCHASE_REQUISITION, PURCHASE_ORDER, PROGRESS_CLAIM (subcontractor), CHANGE_ORDER, PROPOSAL (shared/approvals.ts:12-80; schema:2208-2219).
- Per type: amount bands (half-open, no overlap), optional department scope, ordered role chain, escalation by notification only, temporary delegation (schema:2236-2276, 2249-2252, 2561-2579; approval.service.ts:180-435).
  Built-in controls: the submitter cannot sign; one person cannot sign two steps; a step's role must hold the document's permission and have an active user (approval.service.ts:339-351; approvals.service.ts:212-255).
- Seeded thresholds (seed.ts:677-693): requisition >= 10,000 -> pm; PO >= 100,000 -> pm then accountant; subcontractor claim >= 250,000 -> pm then accountant;
  change order >= 100,000 -> pm then admin; proposal from 0 -> executive. Below a band, no signature is required and the single permission decides (approval.service.ts:192; procurement.service.ts:281-285).
- Role mapping: see 1.3. All six company roles can be created as roles, but only `pm`, `accountant`, `executive`, `admin` are seeded signers.

Gaps
- Not on the matrix (no signature chain at all): goods receipts (seed.ts:833-837), vendor bills (`finance.payment.write`, seed.ts:857), vendor payments, customer invoices, milestone verification,
  project stage changes, stock transfers, budget overruns, petty cash, handover, direct site receipts.
- The permission behind a signature is shared across document types (`scm.procurement.approve` covers requisition, PO and subcontractor claim; `projects.project.approve` covers change orders): shared/approvals.ts:36-70.
- Department scope and escalation hours exist in schema/resolver but cannot be set through the rule DTOs or the admin matrix screen (approvals/dto.ts:23-71; approval-matrix.tsx:95-125); only the seed sets `escalationHours = 48` (seed.ts:713).
- The default PO chain does not include the GM (see E3).

---------------------------------------------------------------------------------------------------------

## 3. Other findings worth knowing before planning

1. Requisition "convert" from the UI marks CONVERTED with no PO (E2). **(code-read)**
2. Requisition form's item list calls a route that does not exist (`/commercial/items`) (E2). **(code-read)**
3. `ReceiveDto.locationId` is ignored by the server (E4).
4. Procure-to-pay beyond PO approval is API-only; the UI offers Receive on APPROVED POs which the server refuses (1.4, E3, E4). **(code-read)**
5. Job-cost "committed" omits SENT POs; `ProjectCommitment` ledger is unread (E6).
6. Small requisitions (no band) require the submitter to hold the approve permission (E2). **(code-read)**
7. Budget-line ids on requisition/PO lines are not validated against the project (1.2).
8. Eleven declared-but-unused fields (1.5) - several of them are exactly the hooks the owner's documents need (engineer, planned dates, advance %, retention due date, warranty end date, site locations).
9. Project and requisition lists are organisation-wide for every role that can read them; there is no per-project scoping for engineers (E1).
10. The nearest existing "execution" artefact (work orders, timesheets, parts) is an O&M/field-service module; it cannot currently be pointed at a construction project from the web form (E5, E10).

## 4. Dependency observations (opinion, for planning)

- Almost every missing piece (E5, E6, E4b, E9, E10) needs the same prerequisite: a **project budget made of editable lines with item/unit/qty/price** (replace or extend the category-bucket `WbsElement`), plus ways to
  capture a budget line on every document (the web currently captures none).
- E4/E11 need **site locations** that can be created per project and a receipt/transfer/issue document that carries project + budget line; the movement ledger already exists.
- E8/E9/E14 need new **approval-matrix document types** and permissions; the matrix design (amount bands + role chain) already supports adding types as long as an applier is registered
  (approval.service.ts:163-171).
- E10/E12 share one new event: **acceptance**, which should start warranties and make the final payment/retention due.

## 5. Not verified

- Nothing was executed; all runtime behaviour is inferred from source. Items tagged (code-read) are the most worth a quick manual check.
- Live data on the demo server (whether any budget lines, locations or roles were added directly in the database) was not inspected; seed-defined roles/thresholds may differ in production because administrators can edit them.
- Web reachability is inferred from grep of API calls; client components were not rendered.
- Behaviour of `StatusBadge`/label coverage for newer PO states (SENT, PENDING_APPROVAL) was not checked.
- The pre-contract half (budget estimate creation, proposals, contract signing) belongs to the other agent; only its hand-off to the project (1.1) is described here.
