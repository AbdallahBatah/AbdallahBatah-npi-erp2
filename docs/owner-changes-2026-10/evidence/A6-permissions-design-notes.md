# A6 - Notes for implementing ADR-02 (permission model)

> From the `erp-architect` agent that wrote `../ADR-02-permissions_AR.md`, 2026-10-12, code read at `feat/owner-changes-p1@f431ce3`. Nothing was run. English, for the implementing session; the owner-facing design is the ADR. The main session made the exception reason optional and added the proposed approval rules to the presets page after this note was written.

**State of the branch.** While this ADR was being prepared, three commits landed on `feat/owner-changes-p1`: `8fe9cb9` (P1-1 hide telemetry/PPA), `aa28c01` (P1-1b), `f431ce3` (P1-2). All line numbers above were re-checked at `f431ce3`. Task 1 partly overlaps what P1-2 did: the requisition item picker now calls `/items` (`requisitions/page.tsx:82`), which needs `commercial.item.read`, so the lookup in task 3 is still required. The "new requisition" button is still ungated (`:118`).

**Traps I noticed**
- `packages/shared/src/permissions.ts` must stay import-free. `apps/copilot/tests/catalog.spec.ts:27-30` imports it by relative path and relies on that. Put `screens.ts`, `effective-permissions.ts`, `LOOKUP_ACCESS`, `SOD_CONFLICTS` and `ROLE_PRESETS` in new files that import from it, never the reverse.
- `apps/copilot/tests/catalog.spec.ts:163-164` pins the catalogue at exactly 40 keys, and `:119` compares a pack role with all keys (I read only the grep hits, not the whole test). Both will fail on task 4 until the packs' `admin` sets carry all 44 keys.
- `GET /admin/permissions` must stay a flat array with `key`, `groupAr`, `labelAr` on every element (`apps/copilot/src/npi/permissions.ts:39-58`). Only add fields.
- Madar persists permission keys in its own database (`MemoryFact.sourcePermission`; see `npi-facts.ts:59-62`). Do not rename `crm.customer.read`, `commercial.contract.read`, `scm.procurement.read` or `projects.project.read`, or change what they read for customers, contracts, purchase orders, vendors and projects.
- Hand-copied permission arrays exist in three places and drift: `packages/db/prisma/seed.ts:18-98`, `packages/db/prisma/madar-scratch-orgs.ts` (role arrays up to `:122`), and the six pack files. `seed.ts:77` derives `executive` from the `.read` / `.approve` suffixes, so new `.read` keys flow in once they are in the seed's own `ALL_PERMISSIONS`.
- Madar's Playwright NPI API runs on the `npi_erp_e2e` copy. After adding migrations, refresh it and re-seed the scratch organisations; baseline the Madar gates before changing code.
- Existing specs build users without overrides (`jwt.strategy.spec.ts`, `auth.service.spec.ts`), and `follow-up-tasks.service.spec.ts:599` pins the summary route to `CUSTOMER_READ`. The resolver should tolerate an absent relation, or the fixtures need updating.
- `REQUISITION_PERMISSIONS` (`requisitions.service.ts:700-703`) is a dead export that still names `PROCUREMENT_READ`. Delete or correct it in task 4.
- Role-level SQL predicates to replace with the effective one: `admin.service.ts:57-62` plus the three guard sites, `notification.service.ts:113-136`, `proposals.service.ts:1026-1055`. Keep `approvals.service.ts:230` role-level on purpose, because a rule names roles.
- The three hand-written lockout pre-checks are easier to get right as one post-condition inside each mutating transaction (count effective holders of `admin.user.manage`; throw to roll back at zero). The existing checks are read-then-write and race under concurrent edits. An advisory lock per organisation, as in `proposals.service.ts:1064-1069`, would close that.
- Guard 8 must look at open `ApprovalStep` rows as well as `ApprovalRuleStep`, because steps are copied from the rule at submission (`approval.service.ts:221-223`).
- `admin.service.updateRole` audits outside a transaction today (`:359-376`). Hard rule 3 wants the audit row in the same transaction for the new override path; consider aligning the role path.
- `crm.customer.merge` is only reachable through a tab of `/admin`, whose first load needs `admin.user.manage` (`admin/page.tsx:138-151,330`). So the seeded `executive` cannot reach it today. This matters when deciding where "special keys attached to a screen" render.
- Madar decides `isAdmin` from the role key (`apps/copilot/src/auth/session.ts:151`), not from permissions. A user granted `admin.user.manage` by exception is not an admin in Madar's shell, and an `admin`-role user with denials still is.
- Sub-threshold requisition path, from reading only: `submit()` commits `SUBMIT` and then calls `applyApproval` with the same user (`requisitions.service.ts:399-415`). For a requester without `scm.procurement.approve` the second transition should throw 403 after the first has committed, leaving the requisition in `PENDING_APPROVAL` with no chain. Setting the band to zero (question 1) avoids the path; I did not reproduce it.
- Deploy window and rollback: old code rejects saving a role that contains a key it does not know (`admin.service.ts:283-290`). Ship a `down.sql` for the backfill, following the 0021 precedent.
- `apps/web` has no test runner. Everything that decides visibility should live in `packages/shared` and be tested from `apps/api`; the rest is the browser sweep.

**Not verified**
- Nothing was run: no tests, no build, no browser.
- The live demo database: roles, users, extra roles, approval rules, and whether a Madar pack was ever applied there.
- The Madar persona prompt texts, and how the PR and PO flows behave when `/items` or `/projects` answer 403 (intake treats a failed read as unreadable in `apps/copilot/src/intake/resolution.ts:72`; I did not trace what the user then sees).
- Whether the lookup field names match the Prisma models. I took them from the page-side interfaces in `procurement/page.tsx:36-49`, not from `schema.prisma`.
- The per-role sidebar counts in section 3-4 are hand-counted from the proposed sets, not computed by code.
- A2's role-by-screen matrix was taken as given.

**One judgement call to confirm before task 9.** Keeping `accountant` for the company's accountant and creating `finance_manager` new is name-faithful, but it narrows the seeded `accountant` from 21 keys (after backfill) to 3. Anyone currently in that role on the live server loses most screens when the owner applies that preset. The preview shows this, but it is worth saying to him in words.
