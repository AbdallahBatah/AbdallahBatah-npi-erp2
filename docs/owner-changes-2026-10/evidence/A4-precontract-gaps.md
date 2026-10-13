# A4 — Pre-contract half of the operating cycle: gap analysis against the system as it is today

Repository: `C:\dev\npi-erp`, branch `feat/copilot`, HEAD `1a4d545` (read-only: no servers, tests, builds or state-changing git commands were run).
All paths below are relative to the repository root. `apps/copilot` was ignored as instructed. The forbidden paths (`docs/archive/**`, `PROGRESS.md`, etc.) were not read.
Method: every claim comes from reading source (Prisma schema, services, controllers, DTOs, seed, web pages). Nothing was executed, so behaviour is "as written in code", not "observed running". Where I could not confirm something it says **not verified**.

The company cycle being compared:
عميل محتمل → تفاوض → فرصة مشروع → دراسة وتكلفة → موازنة تقديرية → اعتماد المدير العام → عرض سعر → موافقة العميل → عقد.

---

## 0. Scorecard

| # | Requirement | Status | One-line verdict |
|---|---|---|---|
| R1 | Lead → negotiation → opportunity | **PARTIAL** | Lead, conversion, activity log and follow-up tasks all exist; the funnel order differs from the company's, specs are free text only, owner cannot be assigned. |
| R2 | Estimated budget («نموذج مقايسة مشروع») before any quotation | **MISSING** | No budget/estimate document, no 18-item work catalogue, no costing header, no 3 signatures. Only a post-contract WBS budget exists. |
| R3 | Budget templates by system size (990 / 1230 panels) | **MISSING** | No template concept anywhere. |
| R4 | GM approval of the budget before a quotation | **PARTIAL** | A generic approval engine exists and GM-level (`executive`) approval is wired to the *proposal*; there is no budget to approve and no gate forcing a review before a quotation is created. |
| R5 | Official quotation from the approved budget (print/PDF, sent) | **PARTIAL** | Numbered, versioned, approved, "sent" status exists; no link to a budget, no print/PDF/e-mail, no customer-facing document. |
| R6 | Customer acceptance → automatic contract draft (50/30/20), editable | **PARTIAL** | Acceptance is recorded; contract creation is manual, schedule typed by hand, no 50/30/20 default, and a draft contract cannot be edited or cancelled. |
| R7 | Internal approvals (which documents, who, thresholds, extensibility) | **PARTIAL** | Matrix covers 5 document types incl. PROPOSAL; not budget, contract or discount; adding a type needs code + migration + deploy. |
| R8 | Foreign-currency / multi-scenario costing | **MISSING** | Currency is only a text label; no FX rate, no per-watt pricing, no scenarios. |
| R9 | Contract data captured upstream | **PARTIAL (mostly MISSING)** | CR, VAT, mobile, e-mail, contacts exist; national ID, national address, signatory, site, sizing detail, duration, warranties do not. |

---

## 1. Explicit answers

### 1.1 Statuses / stages and who may move them

**Lead** — `LeadStatus`: `NEW → QUALIFIED → DISQUALIFIED → CONVERTED` (`packages/db/prisma/schema.prisma:53-58`; labels `packages/shared/src/enums.ts:35-40`).
- Born `NEW` by anyone with `crm.lead.write` (`apps/api/src/modules/crm/leads.controller.ts:47-51`; `leads.service.ts:88-120`).
- **There is no state machine.** `PATCH /leads/:id` accepts any of the four statuses (`crm/dto.ts:30,77`) and writes the DTO as-is (`leads.service.ts:122-139`, `data: dto as any`). The web UI offers no way to set QUALIFIED/DISQUALIFIED — only badges exist (`apps/web/src/components/ui.tsx:281-283`; no `api.patch('/leads…')` anywhere in `apps/web/src`).
- `CONVERTED` is set by `POST /leads/:id/convert`, requiring both `crm.lead.write` and `crm.opportunity.write` (`leads.controller.ts:63-71`). Conversion only refuses an already-CONVERTED lead (`leads.service.ts:146-149`); a NEW or DISQUALIFIED lead converts just as well.

**Opportunity** — `OpportunityStage`: `PROSPECTING (محتمل) → QUALIFICATION (تأهيل) → PROPOSAL (عرض سعر) → NEGOTIATION (تفاوض) → WON (رابحة) | LOST (خاسرة)` (`schema.prisma:63-70`; `enums.ts:45-52`). Type `DIRECT | TENDER` (`schema.prisma:74-77`).
- Manual moves: `POST /opportunities/:id/stage`, permission `crm.opportunity.write` (`crm/opportunities.controller.ts:57-65`). Rules in `packages/shared/src/opportunity-stages.ts:50-63`: one step forward, any step back, LOST from any open stage (loss reason mandatory, from an admin-editable reason list: `opportunities.service.ts:279-305`, `schema.prisma:606-621`), WON by hand **only from NEGOTIATION**, WON/LOST are final.
- Automatic moves: creating the first proposal carries PROSPECTING/QUALIFICATION → PROPOSAL (`opportunities.service.ts:312-319`); creating a contract carries any open stage → WON (`opportunities.service.ts:326-334`, called from `commercial/contracts.service.ts:107`). WON/LOST emit outbox events (`opportunities.service.ts:400-413`).
- Owner is the creator and is never reassigned: `ownerId: user.userId` (`leads.service.ts:104,221`; `opportunities.service.ts:181`); neither `UpdateLeadDto` nor `UpdateOpportunityDto` has an owner field (`crm/dto.ts:73-83,124-144`).

**Proposal and its revisions** — `ProposalStatus`: `DRAFT → PENDING_APPROVAL → APPROVED → SENT → ACCEPTED | REJECTED (by customer) | EXPIRED | SUPERSEDED (revision only)` (`schema.prisma:110-119`). `Proposal.status` mirrors the current revision (`commercial/proposals.service.ts:915-929`). Revisions are numbered (`schema.prisma:706-742`).
- Moves are executed by the workflow engine; the legal moves and the permission per move are data seeded in `packages/db/prisma/seed.ts:867-897` (migration 0027 writes the same for existing orgs — **not verified beyond the comment at `seed.ts:863-864`**).
  - SUBMIT (DRAFT→PENDING_APPROVAL, condition `total > 0`), SEND, ACCEPT, REJECT (customer), REVISE: permission `commercial.proposal.write` (`seed.ts:882,886-888,892-895`; controller `commercial/proposals.controller.ts:78-107`).
  - APPROVE / RETURN: permission `commercial.proposal.approve`, performed only by the approval matrix, no endpoint offers them (`seed.ts:883-885`; `proposals.service.ts:586-638`; `approvals/approvals.controller.ts:107-115`).
  - EXPIRE: the system actor only, nightly at 01:30 Riyadh (`proposal-expiry.scheduler.ts:30`; `packages/shared/src/workflow.ts:141`).
- Approver rules: whoever submitted cannot sign, and no one signs two steps (`common/approval.service.ts:339-351`); submit is refused if no other approver exists (`proposals.service.ts:535-538`, `1026-1055`).
- Revisions: a new revision is only possible when the current one is APPROVED/SENT/REJECTED/EXPIRED; it locks the previous one as SUPERSEDED (`proposals.service.ts:51,363-369,776-785`). A DRAFT is edited in place (`proposals.service.ts:423-491`). After a contract exists, "changes go through a change order" (`proposals.service.ts:777-779`).
- **Customer acceptance is an internal click** by a user holding `commercial.proposal.write` (`proposals.service.ts:676-706`; button `apps/web/src/app/(app)/proposals/[id]/page.tsx:744-748`). Nothing customer-facing, no signed copy on the proposal (`AttachmentEntity` has no PROPOSAL: `schema.prisma:2146-2155`).

**Contract** — `ContractStatus`: `DRAFT, ACTIVE, SUSPENDED, CLOSED, CANCELLED` (`schema.prisma:138-144`).
- Created `DRAFT` by `commercial.contract.write` (`commercial/contracts.controller.ts:33-37`; `contracts.service.ts:110-139`).
- Only **DRAFT → ACTIVE** is implemented (`contracts.service.ts:157-176`, `contracts.controller.ts:39-43`), one click, no approval. **SUSPENDED / CLOSED / CANCELLED are never set by any code** (grep over `modules/commercial|projects|finance`, only fiscal-period and project-stage matches).
- Milestones: `PENDING → VERIFIED` (contract.write, `contracts.service.ts:182-230`) `→ INVOICED` (finance) (`schema.prisma:152-156`).

### 1.2 Do proposals have line items with cost and margin?
**Yes, with caveats.**
- Each revision has `BomLine` rows: `qty`, `unitCost` (cost), `originalUnitCost`, `costSource` (GRN/PO/CATALOGUE/MANUAL), `costDate`, `costAgeDays`, `costOverrideReason`, `unitPrice` (selling), `lineTotal` (`schema.prisma:744-770`). Revision header: `subtotal` (= cost), `marginAmount`, `totalAmount` (`schema.prisma:715-717`; maths `apps/api/src/common/proposal-pricing.ts:35-43`).
- Cost is fetched by the server from the last accepted goods receipt, else last approved PO, else catalogue `Item.unitCost` (`commercial/item-cost.service.ts:35-94`); a manual change needs a reason (`proposals.service.ts:864-895`). Price = cost + a margin % typed or taken from a `PricingScheme` (`proposals.service.ts:822-846`) or typed per line.
- Lines must be catalogue `Item`s (`proposals.service.ts:812-820`); the seed has only 5 items (`seed.ts:264-270`).
- Cost/margin are hidden from users without `finance.costs.view` (`commercial/revision-pricing.ts:6-8,67-81`).
- **No margin %** is computed or shown on a proposal (UI shows margin *amount* only: `proposals/[id]/page.tsx:633-647`); no per-line margin; no minimum-margin rule (grep for margin floor/below-cost guards found none). Margin % exists only in the post-contract profitability report (`apps/api/src/modules/finance/reports.service.ts:431-496`, which re-prices from catalogue cost, not from the proposal's stored cost).

### 1.3 Can a proposal be printed or exported?
**No.**
- `ProposalsController` routes are list, cost-lookup, get, create, add/update revision, submit, send, reject, accept — nothing that renders a document (`proposals.controller.ts:23-107`).
- The web app has exactly one print route, for invoices (`apps/web/src/app/(app)/invoices/[id]/print/page.tsx:1-8,99`; `find` for `print` dirs returns only that one). Print CSS infrastructure exists (`apps/web/src/app/globals.css:136-160`) and the organisation letterhead data exists (`schema.prisma:211-229`) but neither is used for proposals.
- CSV export exists only for ledger and statements (`apps/web/src/lib/csv.ts:14-25`, `ledger/page.tsx:8,148,198`, `statements/page.tsx:10,117,135`).
- No PDF, mail or messaging library in `apps/api/package.json` or `apps/web/package.json` (grep for mail/pdf/puppeteer/twilio: no hits). "Send" is a status change plus an outbox event `proposal.sent` (`proposals.service.ts:661-672`; event vocabulary `workflow.ts:168-171`) that **nobody subscribes to** — the only subscribers are procurement's (`procurement.service.ts:75-84`, `requisitions.service.ts:76`).

### 1.4 How is a contract created from an accepted proposal today?
**Manual, not automatic.**
1. Accepting a revision only sets it ACCEPTED/`isWinning` (`proposals.service.ts:676-706`). Nothing reacts to `proposal.accepted` (no subscriber).
2. A user with `commercial.proposal.write` presses «إنشاء عقد» on the winning revision (`proposals/[id]/page.tsx:648-660`), fills a modal (`1005-1057`), which calls `POST /contracts` (`contracts.controller.ts:33-37`).
3. **Copied from the proposal:** customer (via the opportunity), opportunity, proposal, revision link, and `totalValue = revision.totalAmount` (`contracts.service.ts:66-90,111-120`). The API even lets the caller override `totalValue` (`contracts.service.ts:89`, DTO `commercial/dto.ts:100`).
4. **Not copied:** currency (`contracts.service.ts:111-136` omits it; column defaults to SAR, `schema.prisma:789`), line items/scope (reachable only through the `proposalRevision` relation), validity, terms.
5. **Typed by hand:** contract type (default EPC), retention % (default 5), advance % (default 20), and up to **3** milestones (description + absolute amount, trigger fixed to PROGRESS) — at least one required (`proposals/[id]/page.tsx:420-470,1018-1044`). There is no 50/30/20 default, amounts are absolute not percentages (`schema.prisma:816`), and there is no check that milestones add up to the contract value (no such validation in `contracts.service.ts:101-139`). `advancePct` is stored but used by no logic (grep: only written at `contracts.service.ts:124`); `retentionPct` is applied when milestone invoices are made (`finance/invoices.service.ts:146-147`).
6. Side effect: creating the draft contract immediately marks the opportunity WON (`contracts.service.ts:107`, `opportunities.service.ts:326-334`).
7. Server guard: only an ACCEPTED revision with no existing contract is accepted (`contracts.service.ts:78-85`). But `POST /contracts` also accepts a bare `customerId` with no proposal at all (`contracts.service.ts:92-99`), so the budget → quote → approval chain is not enforced for contracts.

---

## 2. Requirement-by-requirement

### R1 — Lead → negotiation → project opportunity — **PARTIAL**
**What exists**
- *Lead capture*: model `Lead` (`schema.prisma:527-551`: code, contact, company, source enum `schema.prisma:44-51`, estimatedKwp, phone, email, notes, owner); API `leads.controller.ts:23-71`, `leads.service.ts:88-120`; page `apps/web/src/app/(app)/leads/page.tsx:70-90` (the form omits `notes`, which the API accepts: `crm/dto.ts:69`).
- *Conversion*: `leads.service.ts:145-249` — creates a customer when none is linked (with duplicate check on CR/VAT/mobile, `162-206`), an opportunity in PROSPECTING (`208-223`), marks the lead CONVERTED (`225-232`). The UI converts with an empty body (`leads/page.tsx:95`).
- *Negotiation tracking*: communication log `Activity` NOTE/CALL/MEETING with "when", contact, files and an optional follow-up task in the same transaction (`schema.prisma:80-84,1136-1160`; `crm/activities.controller.ts:14-50`; `activities.service.ts:76-122`); `FollowUpTask` with due date, reminder, assignee, in-system reminder/overdue notices (`schema.prisma:1168-1204`; `follow-up-tasks.controller.ts:14-95`; `follow-up-reminder.scheduler.ts`). Shown on the opportunity page tabs (`opportunities/[id]/page.tsx:209-220,446-452`) and the `/tasks` page.
- *Studying the customer's specifications*: only free text and attachments (pdf/xlsx/docx/dwg/images, ≤10 MB, on CUSTOMER/OPPORTUNITY/ACTIVITY: `platform/attachments.service.ts:20-28,32-41`; `schema.prisma:2146-2155`). A search of api/web/shared/schema for "specification/مواصفات" found nothing structured.
- *Opportunity*: `schema.prisma:553-602` (stage, DIRECT/TENDER with bid-bond fields, estimatedKwp, estimatedValue, expected close date, loss reason).

**Gaps (business terms)**
1. **The funnel is not the company's cycle.** The system's order is prospecting → qualification → **proposal → negotiation** (`opportunity-stages.ts:4-5`); the company negotiates *before* an opportunity exists and then studies/costs/budgets/gets GM approval *before* quoting. There are no stages for دراسة وتكلفة / موازنة تقديرية / اعتماد المدير العام, and the "Create proposal" button is available from any open stage (`opportunities/page.tsx:233-246`, `opportunities/[id]/page.tsx:372-378`).
2. "Responsible: Projects GM" cannot be expressed: the owner is whoever created the record and cannot be changed (see 1.1). There is no hand-over to the Projects GM or Technical Office except by creating a follow-up task (assignable to any active user: `follow-up-tasks.controller.ts:51-55`).
3. Lead qualification is invisible: QUALIFIED/DISQUALIFIED cannot be set from the screen and conversion does not require them (1.1).
4. A lead converted from the screen produces a customer with no CR/VAT (the mandatory-key rule is deliberately skipped at conversion: `leads.service.ts:163-169`; the customer page then flags it: `customers/[id]/page.tsx:154`).
5. No structured record of what the customer asked for (system type, sizing, constraints) beyond notes/attachments.

---

### R2 — Estimated budget («الموازنة التقديرية» / «نموذج مقايسة مشروع») before any quotation — **MISSING**
**Evidence of absence**
- No budget/estimate model in the schema: the only "budget" is `WbsElement.budgetAmount` (`schema.prisma:1248-1256`), created **after** a contract is ACTIVE and a project is opened, bucketed by item category at catalogue cost (`projects/projects.service.ts:61-146`; requires ACTIVE contract at `82-84`; buckets `89-95`; bucket names `18-27`). Grep for budget/estimate/مقايسة/موازنة across `apps/api/src`, `apps/web/src`, `packages/shared/src`, `schema.prisma` finds only: that project WBS budget (API and `projects/[id]/page.tsx`), purchase-requisition estimates (`procurement/requisitions.service.ts:147`), the opportunity's two free numbers `estimatedKwp`/`estimatedValue` (`schema.prisma:562-563`), and the post-contract profitability report (`finance/reports.service.ts:431-496`). The only Arabic uses of «الموازنة»/«ميزانية» are the project job-costing labels (`apps/web/src/lib/messages.ts:95,972,976,1033`); «مقايسة» appears nowhere in code.
- No permission for it (`packages/shared/src/permissions.ts:6-77`), no nav entry (`apps/web/src/lib/nav.ts:21-35`: dashboard, leads, customers, opportunities, tasks, proposals, contracts).
- Quotation creation has no prerequisite except an open opportunity (`proposals.service.ts:261-303`).

**Nearest building blocks (not a substitute)**
- Proposal revision already carries contract value (`totalAmount`), estimated cost (`subtotal`), expected profit (`marginAmount`) (`schema.prisma:715-717`) — i.e. the header figures of the company's form — but only after a quote exists, visible only with `finance.costs.view`, with no margin %, and no project-name/contract-value header layout.
- Lines are inventory `Item`s with a free-text `uom` (`schema.prisma:623-633`), so «تقديرية» (lump sum) is *possible* as a unit string, but the proposal screen never shows the unit (`uom` does not appear in `proposals/[id]/page.tsx`).
- `ItemCategory` = MODULE/INVERTER/MOUNTING/CABLE/BOS/SPARE/SERVICE (`schema.prisma:94-102`): no labour, equipment-rental, indirect-cost or financing classes. The vocabulary MATERIAL/LABOUR/SUBCONTRACT/EQUIPMENT/OVERHEAD exists (`schema.prisma:1081-1087`) but only on *actual* cost postings (`ProjectCostEntry`, `schema.prisma:1401-1418`).
- The seeded catalogue has 5 items; none of the 18 work items (`seed.ts:264-270`). Items are creatable with `commercial.item.write` (admin only in the seed) (`commercial/items.controller.ts:29-33`).
- Cost is *auto-fetched* from purchase history (`item-cost.service.ts:35-94`) — right for purchased materials, wrong for an engineer typing estimated quantity × unit price for labour, rentals, indirects and financing cost.

**Gap (business terms):** The Projects GM and Technical Office cannot prepare a priced work-item estimate for an opportunity in the system, cannot see expected profit/margin % before quoting, and cannot capture the three sign-offs (Technical Office, Projects Manager, GM) on a form. The company's spreadsheet remains the only place where this step lives.

---

### R3 — Budget templates by system size (990 panels = 643.5 kW; 1230 panels = 799.5 kW) — **MISSING**
- No template/preset concept for estimates or proposals anywhere (grep "template": only FSM maintenance-checklist templates, unrelated: `apps/api/src/modules/fsm/fsm.service.ts:331-335,744`).
- Closest things: a new proposal revision pre-fills from the previous revision (`proposals/[id]/page.tsx:302-334`); `PricingScheme` is a margin preset (`schema.prisma:649-666`), seeded with one scheme «STD 18%» (`seed.ts:354-365`) and readable but not creatable/editable via API or UI (`reference/reference.controller.ts:102-109`; no `pricingScheme.create/update` outside the seed).
- Nothing derives quantities from kW; `DesignVersion.capacityKwp` is just a stored number (`schema.prisma:668-685`; written only from the proposal form, `proposals.service.ts:331-343`).

**Gap:** every estimate starts blank. There is no one-click starting point for a 643.5 kW or 799.5 kW plant, and no place to hold default quantities until prices are filled in later.

---

### R4 — GM approval of the estimated budget before a quotation may be issued — **PARTIAL**
**What exists (for the proposal, not a budget)**
- Generic approval gate: `ApprovalService.gate()` finds the amount band and opens a role chain (`apps/api/src/common/approval.service.ts:180-250`); decisions with separation of duties (`300-435`); bell notification to the role (`613-635`); screen `/approvals` with an inbox and a control history (`apps/web/src/app/(app)/approvals/page.tsx:17-40`).
- PROPOSAL is a covered type (`packages/shared/src/approvals.ts:71-79`; `schema.prisma:2216-2218`). Default rule: **every proposal from SAR 0 is signed by role `executive`** (`seed.ts:689-692`); `executive` holds all `.approve` keys, `finance.costs.view`, and audit read (`seed.ts:75-84`). Design decision CRM-S4-a is recorded at `docs/crm-phase-1/step-4-proposals-contract.md:3`.
- Submit/approve/return flow in `proposals.service.ts:506-638`; a rejected proposal goes back to DRAFT with the approver's note (`620-638`); submit is refused if the only possible approver is the author (`535-538`).

**Gaps (business terms)**
1. **There is no budget to approve**, so the GM cannot review a cost build-up *before* the quotation is drafted. The review happens on the quotation itself, which is already priced.
2. **Nothing forces the review first.** A quotation can be created at any open opportunity stage (`proposals.service.ts:261-303`); a contract can even be created with no proposal at all (`contracts.service.ts:92-99`).
3. The approval is keyed on the *selling total* (`approvals.ts:77-78`), not on margin or risk. The approver's inbox row and decision dialog show only code, document type, selling amount and the chain (`apps/web/src/components/approvals.tsx:186-216,272-279`); cost and margin *amount* are visible only after opening the proposal and only with `finance.costs.view` (`proposals/[id]/page.tsx:633-647`). No margin %, no loss-making warning, no financial-risk indicator, no minimum-margin threshold.
4. The three-signature chain of the company form (Technical Office → Projects Manager → GM) is technically configurable as a 3-step chain, but every step role must hold the *same* single permission key for the document type (`approvals/approvals.service.ts:220-235`; `approvals.ts:24-29`), so each signer would need `commercial.proposal.approve`.

---

### R5 — Quotation issued from the approved budget as an official document (print/PDF) and sent — **PARTIAL**
**What exists:** a numbered proposal `PRP-xxxxx` (`seed.ts:218`) with numbered revisions (`schema.prisma:687-742`), mandatory validity date with nightly auto-expiry (`proposals.service.ts:795-810`; `proposal-expiry.scheduler.ts:30`), approval before sending (`proposals.service.ts:506-613`), a «send» step (`643-673`), in-app history/audit, list page with status and "pending with <role>" (`proposals/page.tsx:96-135`).

**Gaps (business terms)**
1. Not issued *from a budget* (R2/R4): it is created from an opportunity and priced from stock items.
2. **No official document**: no print view, PDF or export (1.3). The screen shows only SKU·name, quantity, selling price and line total (`proposals/[id]/page.tsx:575-632`) — no unit, description, scope, payment terms, warranty text, validity wording, signatures or letterhead. Staff would retype it in Word.
3. **"Send" sends nothing**: it flips the status; no e-mail/WhatsApp/PDF, no subscriber to `proposal.sent` (1.3).
4. The customer's signed copy cannot be attached to the proposal (`schema.prisma:2146-2155`); it could be attached to the opportunity or an activity entry.

---

### R6 — Customer acceptance recorded; accepted quotation → automatic contract draft (50% / 30% / 20%), editable before approval — **PARTIAL**
**What exists:** acceptance (ACCEPT, with confirmation, winning revision marked, history kept) and rejection-by-customer with a mandatory reason (`proposals.service.ts:676-730`; `proposals/[id]/page.tsx:399-418,744-753`); the manual contract path and what it copies (1.4); milestones, verification and invoice generation exist (`contracts.service.ts:182-230`, `contracts/[id]/page.tsx:62-92,161-205`).

**Gaps (business terms)**
1. **Not automatic**: someone must remember to create the contract and re-type the type and the schedule (1.4). No subscriber to `proposal.accepted`.
2. **No payment-schedule standard**: no 50/30/20 default, no percentage entry, no check that the three amounts equal the contract value, UI limited to three milestone rows, `advancePct` is dead data (1.4). The milestone trigger vocabulary DATE/PROGRESS/EVENT exists (`schema.prisma:146-150`) but the UI fixes PROGRESS.
3. **Terms are not editable and a mistake cannot be fixed**: there is no update/cancel/delete route for contracts (`contracts.controller.ts:21-53`); a revision may have only one contract (`contracts.service.ts:83-85`; `schema.prisma:783`); once a contract exists the proposal refuses changes (`proposals.service.ts:777-779`); CANCELLED is never set by code. A wrongly typed draft contract is therefore stuck (by code reading — not exercised).
4. **No contract approval**: DRAFT → ACTIVE is a single click by `commercial.contract.write` (`contracts.service.ts:157-176`); there is no CONTRACT document type in the approval matrix (`approvals.ts:12-18`).
5. Execution dates are accepted by the API (`commercial/dto.ts:98-99`) but neither asked for in the creation form (`proposals/[id]/page.tsx:1005-1057`) nor shown on the contract page (`contracts/[id]/page.tsx:119-140`).
6. Currency is not carried to the contract (1.4 item 4).
7. The opportunity becomes WON the moment a *draft* contract is saved (1.4 item 6).

---

### R7 — Internal approvals: which documents, who approves, thresholds, how to add a type — **PARTIAL**
**Documents covered today** (the matrix): purchase requisition, purchase order, subcontractor progress claim, change order, proposal (`packages/shared/src/approvals.ts:12-18,35-80`; `schema.prisma:2208-2219`). **Not covered:** budget/estimate (does not exist), contract, discount, lead/opportunity, invoice, vendor bill (the vendor bill has a workflow with permissions but is not routed through the matrix: `seed.ts:840-862`), journal entries.

**Who and thresholds**
- Rules = amount bands per document type, half-open `[min, max)`, optionally scoped to a department, each with an ordered chain of **roles** and an optional escalation window (`schema.prisma:2236-2276`; `approvals.ts:88-100`; resolution with department-beats-organisation `approval.service.ts:257-296`).
- Seeded defaults (`seed.ts:677-693`): requisition ≥ 10,000 → `pm`; PO ≥ 100,000 → `pm`, `accountant`; progress claim ≥ 250,000 → `pm`, `accountant`; change order ≥ 100,000 → `pm`, `admin`; **proposal ≥ 0 → `executive`**. Escalation 48 h, notify-only (`seed.ts:713`; `approval-escalation.scheduler.ts:31`). Below any band the single write permission decides, as before (`schema.prisma:2205-2206`; `approval.service.ts:192`) — except that a proposal submitted where no band applies may only be self-approved by someone holding `commercial.proposal.approve` (`proposals.service.ts:547-553`).
- Fixed controls: the submitter cannot approve; one person cannot sign two steps (`approval.service.ts:339-351`); temporary delegation exists (`schema.prisma:2561-2579`; `approval.service.ts:326-348`).
- Amount semantics: proposal = selling total, change order = absolute delta (`approvals.ts:35-80`).

**Admin surface:** matrix editor in Admin (`apps/web/src/components/approval-matrix.tsx:52-120`, API `approvals/approvals.controller.ts:44-70`). It edits bands and role chains. The rule DTO does **not** expose department scope or escalation hours (`approvals/dto.ts:23-48`; `approvals.service.ts:50-62`), so those are seed/SQL-only. Roles (and departments) are creatable from the UI (`admin/admin.controller.ts:53-77`; departments `admin/departments.controller.ts:34-40`) but the **permission catalogue is fixed in code** (`permissions.ts:6-77`).

**How a new document type is added** (all are code changes; none is configuration):
1. Add the value to the Prisma enum `ApprovalDocument` and ship a migration `ALTER TYPE … ADD VALUE` (pattern: `packages/db/prisma/migrations/0026_crm_proposals/migration.sql:24`; Postgres cannot use the new value in the same migration, see its header).
2. Add it to `ApprovalDocumentType` and `APPROVAL_DOCUMENTS` with the permission key and amount label (`approvals.ts:12-18,35-80`); the DTO validator is derived from that list (`approvals/dto.ts:16,24`). The header comment says this alone "is deliberately not enough" (`approvals.ts:1-9`).
3. The owning service must call `ApprovalService.register(type, applier, rejecter)` in `onModuleInit`; the app **refuses to boot** if a listed type has no applier (`approval.service.ts:148-171`; example `proposals.service.ts:131-137`).
4. The owning service must call `approvals.gate(...)` at submit time (example `proposals.service.ts:540-553`).
5. Web: extend `ApprovalDocType`, `DOC_LABEL` and the per-type "open document" link (`apps/web/src/components/approvals.tsx:21-26,53-59,193-201`).
6. If the document has a lifecycle, add a workflow flow: flows are rows in `wf_*` tables written only by seed/migrations — **no API writes them** (grep for `wfDefinition/wfState/wfTransition` create/update/upsert in `apps/api/src` finds none) (`schema.prisma:2375-2450`; `seed.ts:867-897`).
7. Optionally seed a default band (`seed.ts:677-693`).

**Gap (business terms):** the GM/Finance/Technical-Office approvals the company describes can be mapped onto *proposals* today, but a budget approval, a contract approval or a discount approval each need a developer, a migration and a deploy; and a margin- or risk-based trigger does not exist (bands are on amount only).

---

### R8 — Costing in foreign currency; FX; multi-scenario costing — **MISSING**
- Nothing for FX or scenarios: a search of `schema.prisma`, `apps/api/src`, `apps/web/src`, `packages/shared/src` for exchange/fx/usd/per-watt/scenario/sourcing finds only a code comment (`commercial/item-cost.service.ts:22`).
- Currency is a plain text label defaulting to "SAR" on Opportunity (`schema.prisma:564`), PricingScheme (`657`, **never read by any logic**), Proposal (`695`), Contract (`789`), Invoice (`877`), PurchaseOrder (`1281`). There is no rate table, no conversion function.
- The UI never sends a currency when it creates a proposal (`opportunities/[id]/page.tsx:200-207`, `opportunities/page.tsx:117-124`), and the opportunity DTO has no currency (`crm/dto.ts:109-122`) — so proposals made from the screen are always SAR. The API does accept one (`commercial/dto.ts:39-42`).
- Cost lookup only counts purchases in the proposal's currency (`item-cost.service.ts:22,52-85`); the catalogue fallback `Item.unitCost` has **no currency attribute** (`schema.prisma:633`; fallback `item-cost.service.ts:87-92`), so by code reading a USD proposal would treat a SAR catalogue cost as USD (**not run, not verified in practice**).
- Pricing is per unit × quantity (`BomLine`, `schema.prisma:750-753`): no price-per-watt, no «رسوم ونقل» as a separate amount.
- Scenarios: revisions are sequential versions where only the latest is current (`proposals.service.ts:363-369,776-785`), not parallel alternatives. Several `Proposal` rows may sit on one opportunity (no uniqueness constraint: `schema.prisma:702`) but they are unlinked and there is no comparison; margin % is not computed pre-contract at all (1.2).

**Gap:** finance cannot price panels at USD/W, apply the agreed fixed rate, add the separate fees-and-transport amount, or compare China-old / KSA / China-new with a margin for each. That work stays in the company's spreadsheet.

---

### R9 — Data a contract needs, captured upstream — **PARTIAL (identity yes; most else no)**
| Item | Status | Evidence |
|---|---|---|
| Commercial registration number | EXISTS | `Customer.crNumber` `schema.prisma:431`; a company needs CR or VAT `customers.service.ts:244-246`; unique per org via partial index (comment `schema.prisma:461-462`, migration 0023) |
| VAT number | EXISTS | `schema.prisma:430`; 15 digits starting/ending 3 `crm/dto.ts:21-23,42` |
| National ID (individuals) | MISSING | no field on `Customer` (`schema.prisma:422-468`); an individual is keyed by mobile only `customers.service.ts:241-243` |
| National address | MISSING | `Customer` has no address field; only `Organization` (the seller) has `addressAr/En` `schema.prisma:217-218` |
| Authorised signatory (name, capacity) | PARTIAL | `CustomerContact.name/title/isPrimary` `schema.prisma:471-491`, UI `customers/[id]/page.tsx:318-330,535-540`; no "signatory" designation and nothing is carried to the contract |
| Mobile, e-mail | EXISTS | `schema.prisma:433-438`; mobile normalised to `+9665xxxxxxxx` `crm/dto.ts:40` |
| Site: region / governorate / coordinates | MISSING | only `Project.siteRef` free text `schema.prisma:1217`, set when the project is opened after the contract `projects/dto.ts:9` |
| Wells count; pump HP/kW | MISSING | grep for wells/pump/hp in api, web, schema: nothing |
| Panel count, manufacturer, model, nominal watt | PARTIAL | count = BOM qty of MODULE items; model only inside `Item.sku/name` (e.g. "PV Module 550W", `seed.ts:265`); `Item` has no manufacturer or watt field `schema.prisma:623-647` |
| Total kW | PARTIAL | three unsynchronised places: `Opportunity.estimatedKwp` `schema.prisma:562`, `DesignVersion.capacityKwp` `677`, `Project.capacityKwp` `1218` |
| Inverter make / model / kW / count | PARTIAL | INVERTER items in BOM (kW only in the name `seed.ts:266`) |
| Mounting-structure specification | MISSING | MOUNTING items only |
| Execution duration | PARTIAL | `Contract.startDate/endDate` `schema.prisma:787-788` accepted by API but not asked in the form nor shown (R6.5); `Project.plannedStart/End` `1219-1220` later |
| Warranty periods per component | MISSING | `Asset.warrantyEndDate` `schema.prisma:1662` is never read or written by any code (grep); `WarrantyClaim` is post-sale RMA only `schema.prisma:1924-1947` |

Also: the contract record holds only commercial data (`schema.prisma:772-806`) — no snapshot of customer identity, site, sizing, duration text or warranties — and lead conversion from the screen yields a customer without CR/VAT (R1.4).

**Gap:** a contract cannot be drafted from system data; the legal identity block, site, technical sizing and warranty/duration clauses would all be typed outside the system.

---

## 3. Cross-cutting observations

1. **Role mapping (seeded roles only; roles are editable data).** Seeded: `admin`, `sales`, `accountant`, `pm`, `site_engineer`, `executive` (`seed.ts:117-146`) and departments OPS/ENG/FIN/ADM (`seed.ts:724-729`). Closest to the company: GM ≈ `executive` «الإدارة العليا» (the only default proposal approver, `seed.ts:692`); Finance/Accountant ≈ `accountant` (reads proposals/contracts, sees costs, cannot write or approve them: `seed.ts:50-58`); Project engineer ≈ `site_engineer` (field operations, no commercial access: `seed.ts:88-98`). **No** role or department for Projects GM or Technical Office. Notably `pm` has **no** `commercial.proposal.*` or `crm.opportunity.*` key (`seed.ts:61-71`), so a Projects GM seeded as `pm` could not create or send a quotation; `sales` can (`seed.ts:37-47`).
2. **Process order is not enforced end to end**: lead conversion needs no qualification; a proposal needs only an open opportunity; a contract can be created with no proposal; creating a contract wins the opportunity. A mandatory "budget approved" gate would have to be added at proposal creation and at contract creation.
3. **Reusable building blocks** already in place: generic approval gate with applier registration (`approval.service.ts`), workflow engine with data-driven flows and outbox (`common/workflow/*`), attachments on opportunity/activity/customer/contract, typed org settings (`common/org-settings.service.ts:10-52` — no payment-schedule key yet), `Item` master, `DesignVersion`, print CSS plus a working invoice print route, `Organization` letterhead fields, `CostType` vocabulary, follow-up tasks with reminders.
4. **Seed credentials** exist in `seed.ts` (demo users); they are deliberately not reproduced here.

---

## 4. Not verified / limits of this analysis
- I did not have the company's actual operating-cycle document or forms; the 18-item catalogue, form header, signatures, templates and payment terms are taken from the brief.
- Nothing was run: behaviours (e.g. USD catalogue-cost handling, stuck draft contract) are inferred from code and flagged where so.
- The deployed demo server's data (extra roles, items, rules) was not inspected; statements about "seeded" state refer to `packages/db/prisma/seed.ts`. Migration 0027's flow rows were not read line by line (the seed comment says they are identical).
- `docs/crm-phase-1/step-4-proposals-contract.md` (≈45 KB) was only searched, not read in full; used for intent (decision CRM-S4-a at line 3).
- Integration/e2e tests under `apps/api/test` and web e2e specs were not read.
- Whether any customer-facing channel (portal, e-signature) exists outside `apps/api` and `apps/web` — not verified; none was found inside them.
