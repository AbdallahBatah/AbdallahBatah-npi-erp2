# PROGRESS.md — Madar copilot on npi-erp
Package version: 3.0 (2026-09-21). Branch `feat/copilot` (from `main@9db91d7`). Update after every task.

## Environment inventory
Taken 2026-09-27 (kickoff C, STEP 2).

| Item | Found |
|---|---|
| Working copy | `C:\dev\npi-erp`, not under OneDrive, `main` clean and equal to `origin/main` at `9db91d7` before branching |
| Runtime | Node v24.19.0, npm 11.17.0 locally; NPI pinned to Node 20 (engines `>=20`, Dockerfiles `node:20-alpine`, CI `node-version: 20`); Docker 29.7.2, Compose v5.3.1; container `npi-erp-postgres` healthy |
| Baseline on `main@9db91d7` (run 2026-09-27) | `npm run typecheck` pass, `npm run lint` pass, `npm test` 21 suites / 198 tests pass, `npm run test:int` 4 suites / 31 tests pass |
| Project `CLAUDE.md` | none |
| User `CLAUDE.md` | routing table (ERP work → `erp-engineering` skill, ERP testing → `npi-erp-testing`, ERP architecture → `erp-architect` agent, design → `design-agent`), Notion as the single source of project state (project PRJ-2), Arabic to the owner |
| Project `.claude/` | `launch.json` (servers `web` :3000, `api` :4000), `settings.local.json` (22 allow rules), skill `npi-erp-testing` (`SKILL.md`, `scripts/api-smoke.mjs`, `scripts/ui-sweep.js`) |
| User agents (`~/.claude/agents`) | `agent-architect`, `design-agent`, `design-critic`, `erp-architect` |
| Agents callable from this session | `general-purpose`/`claude` (model selectable, incl. Sonnet), `Explore`, `Plan`, `erp-architect`, `design-critic`, `agent-architect`, `claude-security:*`; `design-agent` is not callable as a subagent here |
| User skills relevant to this work | `erp-engineering`, `nestjs-best-practices`, `nextjs-app-router-patterns`, `prisma-client-api`, `prisma-database-setup`, `playwright`, `test-driven-development`, `systematic-debugging`, `subagent-driven-development`, `code-review-and-quality`, `vibesec`, `accessibility`, `web-design-guidelines`; built-in `code-review`, `security-review`, `claude-api` |
| User commands (`~/.claude/commands`) | none |
| MCP servers | Notion (connected, used for project state), in-app browser + Chrome extension, TestSprite (connected), memory, pdf-viewer, Gmail/Canva/Figma/Netlify and others not relevant here; several plugin servers unauthenticated (GitHub among them — `gh` CLI is used instead) |
| TestSprite | MCP connected; `testsprite_tests/` holds earlier generated NPI tests. Credit-based service, so it is **not** used by this package unless the owner asks (STEP 9) |
| `/goal` | not invocable by the implementer in this session; the G conditions in `spec/madar/07` are checked by hand at each milestone gate and recorded here |
| `ANTHROPIC_API_KEY` | **missing** in local `.env` and in `deploy/.env` (checked for presence only, value never read). `.env` and `deploy/.env` are git-ignored |

## Phase 0 results (link)
docs/COPILOT_PHASE0_AR.md — Node version: NPI on 20, copilot container pins `node:24-alpine` | /api/docs-json: available only with `EXPOSE_API_DOCS=1` (200), otherwise 404 | 14.1#1: reproduced, fixed in `d87ad7c` (numbering continues across years) | 14.1#2: reproduced, fixed in `5323df0` (APPROVE goes through the matrix) | contract milestones API: inline in `POST /api/contracts`, no later add-milestone call | provider policy: API inputs/outputs not used for training by default (privacy.claude.com, fetched 2026-09-21)

Phase 0 merged as `4756ba6`, deployed to the demo server 2026-09-27 14:45 (image tag `20260927144531`), G-0-4 verified from outside (`/api/health` 200, `/api/docs` and `/api/docs-json` 404).

## Role mapping
| Role | Agent / substitute |
|---|---|
| DEV | Sonnet 5 subagents (`general-purpose`, `model: sonnet`), one task each, given only the files the task names; the main model (Fable 5.1) writes the brief, reviews the diff, runs Verify and commits |
| DEV — [HIGHER MODEL] T-11, T-16, T-23, T-27 | done by the main model (Fable 5.1) itself, not delegated downward (E.6) |
| DES | literal `spec/madar/03` with tokens read from `apps/web/tailwind.config.ts` (E.2); `design-critic` agent reviews the UI before each gate that ships screens |
| REV | self-review against `06` §1–3 + OWASP written here (E.2), plus the `code-review` skill on each milestone diff; `erp-architect` for any question that touches NPI boundaries |
| TEST | Jest + Playwright per task; project skill `npi-erp-testing` at every milestone gate to prove NPI itself is unchanged |
| SEC | `npm audit --audit-level=high` + secret scan + OWASP list; `security-review` skill at M1, M3 and M5 gates |

## Pinned versions (new packages only; existing majors unchanged)
Registry lookups (`npm view`) on 2026-09-27. Exact versions, no ranges, in `apps/copilot/package.json`.

| Package | Version | Date | Note |
|---|---|---|---|
| next | 14.2.35 | 2026-09-27 | same as `apps/web` (ADR-26) |
| react / react-dom | 18.3.1 | 2026-09-27 | same as `apps/web` |
| tailwindcss | 3.4.19 | 2026-09-27 | same major as `apps/web` (^3.4.14) |
| prisma / @prisma/client | 5.22.0 | 2026-09-27 | same as `packages/db` |
| typescript | as hoisted (^5.6.3) | 2026-09-27 | existing |
| jest / ts-jest | as hoisted (^30.4.2 / ^29.4.12) | 2026-09-27 | existing |
| @anthropic-ai/sdk | 0.128.0 | 2026-09-27 | MIT; peer `zod ^3.25 \|\| ^4` |
| zod | 4.6.5 | 2026-09-27 | MIT; see decision D-3 |
| openapi-typescript | 7.13.0 | 2026-09-27 | MIT; peer `typescript ^5` |
| pdf-parse | 2.4.5 | 2026-09-27 | Apache-2.0; see decision D-2 |
| pdfjs-dist | 6.3.289 | 2026-09-27 | Apache-2.0; rasterizing scanned PDFs (T-21); see D-4 |
| @playwright/test | 1.63.0 | 2026-09-27 | Apache-2.0; engines `node >=20` |
| lucide-react | 1.48.0 | 2026-09-27 | ISC; peer allows React 18 |
| heic-convert | 2.1.0 | 2026-09-27 | ISC; only if HEIC is kept in T-21 |

## Task status
| Task | Status (todo / in-progress / done / verified-offline) | Commit | Notes |
|---|---|---|---|
| T-00a | done | `fix/phase0` | report `docs/COPILOT_PHASE0_AR.md` |
| T-00b | done | d87ad7c | unit 4/4, int 6/6 |
| T-00c | done | 5323df0 | unit 9/9, int 3/3 |
| T-00d | done | `fix/phase0` | gates off on the demo server (owner decision) |
| T-01 | done | a040b1f | M1 — copilot:build, typecheck, lint green; NPI unit 198/198. Font comes from next/font/google exactly as apps/web does (no font files exist in the repo to copy) |
| T-02 | done | 2a9546e | M1 — `npi_copilot` created by `prisma migrate deploy`, 0001_init applied, second run idempotent; db-guard 11/11. NPI database is named `npi_erp` (the spec says `npi`): the guard is an allow-list so both are refused. Client generated to `src/generated/prisma` so NPI's client is never overwritten. Added table `login_attempts` here for T-05's DB rate limit |
| T-03 | done | f5c3554 | M1 — migrations `0002_core` and `0003_position_role_only_unique` applied to local `npi_copilot`, second `copilot:migrate` run reports nothing pending; fts 13/13 and normalize 21/21 against the real database (run by the agent and re-run by the reviewer). Five tables derived under D-7 (see Deviations) |
| T-04 | done | a0a41fb, fb0cb30, 8906e84 | M1 — npi-client 27/27, copilot:build, typecheck, lint green, NPI unit 198/198. `openapi.json` first fetched from NPI build `9db91d7`; after D-8 (`69a02b4`) fetched again: 69 schemas, none empty, so the write calls are now typed against real bodies. `8906e84` adds the Arabic user and role names to the `/auth/me` reader and the department directory call. `/auth/me` and `/auth/login` return no department id |
| T-05 | done | 3e50abd | M1 — auth-session 27, ratelimit 10, e2e 16/16 on desktop and mobile (G-M1-3: sixth failed login answers 429, no prefill). The first e2e run by the agent was 10/14: NPI's own login throttle tripped because the override did not reach the API through nested npm scripts; the e2e run now starts its own API (4077) and copilot (3177) with the values set on the process |
| T-06 | done | a73f1bb | M1 — positions 41/41 (fakes; a type-level check proves the real Prisma client fits). Resolution order: own open assignment for the current role, then NPI directory when the user holds `admin.department.manage`, then role alone. Six persona files (five roles + `default`) |
| T-07 | done | 5065584 | M1 — i18n 6/6, lint rule 14/14, `eslint .` clean for the whole repository, tsc clean, copilot build green. Screens that use the shell arrive with T-08/T-12; `design-critic` reviews them before the gate |
| T-08 | done | a040df3 | M1 — home-queries 18; e2e home compares each tile with what NPI's API returns for the same account, on desktop and mobile. `apps/web` gained one sidebar item (`nav.ts`) with its label (`messages.ts`) and icon path (`icons.tsx`); `npm run typecheck -w @npi/web` green. The item leads nowhere until the reverse proxy routes `/copilot` (T-40) |
| T-09 | done | 590fbc0 | M1 — aead 21, llm 40, llm-db 2 (real database), pseudonymizer 82. Prices re-verified on the official pricing page 2026-09-27 (Haiku 4.5 $1/$5, Sonnet 5 $2/$10 per MTok). Reviewer probed the gate with realistic sentences and sent it back once for leaks (bare organization name, parts of employee names, family name, names without a title); fixed and re-probed. No real model call was made: no API key |
| T-10 | done | def9e46 | M1 — router 45, hr-guard 53, tokens 19. Reviewer replaced substring matching with whole-word matching (`src/text/tokens.ts`) after finding ordinary sentences refused or misrouted |
| T-11 | done | 2842783, 597bf37 | M1 [HIGHER MODEL] — done by the main model. Turn logic, tools, memory, dictionary, prompts and the chat endpoint: agents 30, agents-tools 23, memory 24 (real database). Not yet exercised against a real model: no API key (D-1) |
| T-12 | done | 0bfe771, bab4bd0 | M1 — chat-api 24; e2e chat-ui 9 scenarios on desktop and mobile with the chat endpoint intercepted. Tried by hand in the running app: HR refusal, fixed reply to an entry request, and the "provider not configured" message (no API key) |
| T-13 | done | 2a12cd9, 3b0622f, 7e25af8, 45b0aab | M1 gate — smoke spec, security review, code review and design review done and their findings fixed; live calls with Haiku 4.5 on 2026-10-03; see "M1" under Milestone summaries. Owner decided D-9 (option 1) and wrote «موافق» on 2026-10-03; tag `copilot-v0.1.0` created locally |
| T-14 | done | 82e44dc | M2 — `src/onboarding/profile.schema.ts` (zod 4, cross-checks: approval steps hold the approving permission, doc-type flows need their module and a role that holds the flow permission, positions reference declared roles/departments), `src/onboarding/catalog.ts` (loader keyed only by `PROFILE_KEYS`, `permissionGaps`), `src/npi/permissions.ts` (reader for `GET /admin/permissions`), packs `epc`, `om_provider`, `ppa_operator`, `tests/catalog.spec.ts` 40/40. Copilot suite 619/619, tsc and eslint clean. G-M2-1 (part): all 248 (role, permission) entries of the three packs ∈ the **live** `/admin/permissions` of the local NPI (35 keys, fetched 2026-10-03 as the seeded admin); epc role sets equal NPI's live role sets exactly |
| T-15 | done | 8e2a83e | M2 — packs `general_contracting`, `equipment_trading`, `engineering_consulting` (roles `warehouse_keeper`, `engineer`; «مستخلص» as a null-flow doc type; building materials under `BOS`), six overlays `prompts/overlays/*.md` (Arabic prose 928–1211 chars, each names the pack's doc types, terminology, hidden modules and default thresholds, contains «اعتمد»), `MODULE_NAMES_AR` in `profile.schema.ts`. `tests/catalog.spec.ts` 67/67 (all six packs; admin role = NPI's 35 keys; approval defaults table per `03` §5), new `tests/overlays.spec.ts` 44/44. Copilot suite 690/690, tsc and eslint clean. G-M2-1 (complete): all 470 (role, permission) entries of the six packs ∈ the **live** `/admin/permissions` of the local NPI (35 keys, fetched 2026-10-03). Implemented by a Sonnet agent from a written brief; reviewer fixed two grammar slips and added the «الحاكم هو مصفوفة الاعتماد في NPI» clause to every overlay before committing |
| T-16 | todo | | M2 [HIGHER MODEL] |
| T-17 | todo | | M2 |
| T-18 | todo | | M2 |
| T-19 | todo | | M2 |
| T-20 | todo | | M2 gate — live, needs the API key |
| T-21 | todo | | M3 |
| T-22 | todo | | M3 — verify PDF/image request shape in official docs first (G-02) |
| T-23 | todo | | M3 [HIGHER MODEL] — eval needs the API key and 6 contract documents |
| T-24 | todo | | M3 |
| T-25 | todo | | M3 |
| T-26 | todo | | M3 |
| T-27 | todo | | M3 [HIGHER MODEL] |
| T-28 | todo | | M3 |
| T-29 | todo | | M3 |
| T-30 | todo | | M3 |
| T-31 | todo | | M3 gate — live |
| T-32 | todo | | M4 |
| T-33 | todo | | M4 |
| T-34 | todo | | M4 |
| T-35 | todo | | M4 |
| T-36 | todo | | M4 |
| T-37 | todo | | M4 gate |
| T-38 | todo | | M5 |
| T-39 | todo | | M5 |
| T-40 | todo | | M5 |
| T-41 | todo | | M5 — extends `deploy.sh`; first full run of the fixed `verify()` |
| T-42 | todo | | M5 |
| T-43 | todo | | M5 — live on the demo server |
| T-44 | todo | | M5 |
| T-45 | todo | | M5 |
| T-46 | todo | | M5 release |

## Milestone summaries
### Phase 0
Done and deployed. Two NPI defects fixed with regression tests; docs and login prefill gated and off on the demo server. Not done: nothing inside Phase 0 scope. Found and left open: REJECT/RETURN on a requisition with an open chain (decision D-6).
### M1
**Gate run 2026-09-28. State: ready for the owner's walk-through; not yet approved, not tagged, not pushed.**

What an employee can do now: sign in to Madar with their NPI account, see four tiles read from NPI as themselves, and chat. A question about an employee's performance is refused without any model call. A request to enter a document is recognised and answered with a fixed text until the intake flows of M3 exist. Questions about NPI data go to the model with six read-only tools; every name and identifier is masked before it leaves.

Verification, all run by the reviewer on 2026-09-28 (not taken from agent reports):
| Check | Result |
|---|---|
| Copilot unit suites (`npx jest` in `apps/copilot`) | 24 suites, 579 passed |
| Copilot e2e (`npx playwright test`, desktop and 390 px) | 72 passed: auth, home, chat UI, not-found, smoke |
| `npm run typecheck` equivalents (`tsc --noEmit` copilot, `typecheck -w @npi/web`) | clean |
| `npx eslint .` (whole repository, incl. the no-Latin-UI rule) | clean |
| `npm run copilot:build` equivalent (`next build`) | compiled |
| NPI `npm run build` | exit 0, 32 pages |
| NPI `npm test` | 21 suites, 198 passed |
| NPI `npm run test:int` | 4 suites, 31 passed |
| Project skill `npi-erp-testing`, script `api-smoke.mjs` against a clean local API | 21 of 23 passed. The 2 not passed are "guard not exercised": the local dataset has no project and no outstanding payable (the demo scenarios are not seeded locally). Permissions per role, trial balance, journal balance, the ZATCA chain and the login throttle all passed. The browser sweep of NPI's screens was not run |
| Secret scan of `git diff main..HEAD` | nothing found; a literal demo password in a test comment was removed |
| `npm audit --audit-level=high` | 11 high, 1 critical, all in packages NPI already depends on (decision D-9) |

Goal conditions (`07`):
| G | State | Evidence |
|---|---|---|
| G-M1-1 | met | copilot build compiled; NPI `npm run build` exit 0 |
| G-M1-2 | met | migrations 0001…0004 applied to `npi_copilot`; db-guard rejects `/npi` and `/npi_erp` (11 tests) |
| G-M1-3 | met | `e2e/auth.spec.ts` 22 passed over two projects; sixth failed login answers 429; both fields empty on load |
| G-M1-4 | met | `e2e/home.spec.ts`: each tile equals what NPI's API returns for the seeded admin at that moment (all four are 0 in the local dataset) |
| G-M1-5 | met | router, agents, memory, llm, pseudonymizer, positions suites green; HR guard path makes zero model calls (agents and smoke) |
| G-M1-6 | met under D-9 | smoke passed, the secret scan is clean, and `npm audit --audit-level=high` adds no finding relative to `main` (no finding path under `apps/copilot`; the copilot pins NPI's majors). The owner decided D-9 on 2026-10-03: G-M1-6 reads "zero findings introduced by the copilot's own packages, compared against `main` at each gate". Tag `copilot-v0.1.0` created locally on the gate commit (local, unpushed) |

Reviews:
- **Security review** of the milestone diff (read-only agent): one finding, Medium, in the reviewer's own file: the name dictionary was cached per organization as a whole, so a narrow-permission caller fixed it for everyone and vendor or project names could leave unmasked. Fixed in `2a12cd9`. No authentication bypass, no cross-user or cross-organization read, no SQL or command injection, no path traversal, no token in any response, no unsafe HTML.
- **Code review** (skill `code-review`, medium): five findings, all fixed in `7e25af8`. The serious one was confirmed by a probe: a name masked as a field of a tool result went out in clear one turn later, through the history.
- **Design review** (`design-critic`): verdict "ships with fixes"; two blockers (composer hidden behind the phone's tab bar; every link leaving Madar ended on an English 404) and fourteen findings. Fixed in `3b0622f`.
- **Adversarial review against `06`**: AT-07 (no NPI database URL, no service token, every NPI call carries the session's token) holds and is tested. AT-15 (permission checked before extraction) and AT-19 (tenant isolation through the layer) are partly covered: NPI's 403 and 404 are relayed and never worked around, tested with fakes; their live form belongs to M3 when writes exist. AT-09 and AT-10 are measured in M4.
- **OWASP** (as far as 3.0 states it): A01 every page and route validates the real session, conversations and memory are scoped by user and organization; A02 AES-256-GCM with a fresh IV, cookie value stored only as SHA-256; A03 the one raw query is parameterized, replies are rendered as text; A05 the copilot's database guard refuses any database but `npi_copilot`; A07 login limit 5 per 15 minutes per address plus NPI's own throttle; A08 types are generated only from the committed OpenAPI document. Not covered yet: response security headers and CSP (T-44), upload validation (T-21).

Not done, and why:
- **No call to a real model has been made.** `ANTHROPIC_API_KEY` is missing (D-1). The three prompts (`assistant.md`, `router.md`, `memory-extract.md`), the request shape accepted by the provider and the quality of answers are untested live. Owner scenario rows 1.3 and 1.4 cannot pass until the key is added.
- Scenario row 1.4 needs a remembered fact about a customer; facts from NPI data are built in T-29 (M3). Until then memory holds only what employees state in the chat.
- The sidebar item «مساعد مَدار» in NPI exists (row 1.6) but leads nowhere until the reverse proxy routes `/copilot` (T-40).
- The reply kind of the six messages written before migration 0004 is empty, so in the local conversation of the demo admin the old refusal and error look like ordinary answers. New messages carry their kind.
- The browser sweep of NPI's own screens (second half of the `npi-erp-testing` skill) was not run. NPI's code changed in four places only: one line of `nest-cli.json` and one entry each in `nav.ts`, `messages.ts`, `icons.tsx`.
- The local port 3100 is taken by another project's container (D-10).

Process notes:
- Three modules came back from agents with every test green and were wrong in ways their own tests could not see (pseudonymizer, HR guard, router). Each was probed with realistic sentences by the reviewer, sent back or fixed, and the sentences were added as tests.
- A dev API started by an agent's e2e run at 23:15 stayed alive on port 4000 with the login throttle raised, and made the project smoke script report the throttle as broken. It was stopped; the check passes on a clean instance. The e2e run no longer reuses servers.
### M2
Started 2026-10-03 (evening) after the owner's «موافق» on the M1 gate. Notion task «مَدار — المرحلة ٢» set to «قيد التنفيذ».
- T-14 done (see Task status). Live check: the local NPI's `/admin/permissions` returns 35 keys (`02` §7's figure); the live seeded approval rules are PR ≥ 10,000 [pm], PO ≥ 100,000 [pm→accountant], PROGRESS_CLAIM ≥ 250,000 [pm→accountant], CHANGE_ORDER ≥ 100,000 [pm→admin] — the epc pack's three rules match the first three.
- T-15 done (see Task status). Review note: the overlays state each pack's default thresholds as background information only; the admin may change them in Q3 of setup, so every overlay now says the live NPI approval matrix governs. Suggestion for T-16/T-19: render the thresholds actually applied into the prompt (or drop them from the static overlay) once copilot config exists, so the static text can never contradict NPI.
- Next: T-16 (plan/apply/gaps — main model only, E.6), then T-17…T-20.
### M3
### M4
### M5

## NPI API gaps found (from onboarding apply and execution)
| Gap | Flow | Proposed NPI change (for the engineer) |
|---|---|---|
| Most response bodies are untyped in the OpenAPI document (71 of 177 operations declare a body, nearly all as a bare object) | all | response DTO classes or `@ApiOkResponse` on the endpoints the copilot reads; until then the copilot narrows responses with hand-written readers that cite the NPI source line |
| `GET /auth/me` and `POST /auth/login` do not return the user's department | positions (T-06) | include `departmentId` in both. Checked at T-06: `/admin/departments` and `/admin/departments/directory` both require `admin.department.manage` (`departments.controller.ts`), so an ordinary employee cannot read their own department. Until NPI returns it, the copilot resolves the position from its own assignment table (filled by the admin during setup, M2), then from the directory when the user holds that permission, and otherwise by role alone |
| `POST /auth/login` is throttled per IP (5 per minute, `auth.controller.ts`), and every copilot login reaches NPI from the copilot server's single address | login (T-05) | none required for the demo; for production either raise `AUTH_THROTTLE_LIMIT` for the copilot's address or have NPI trust a forwarded client address from the copilot. NPI's 429 is shown as «محاولات كثيرة» |
| Query parameters `search`, `status`, `take`, `skip` are documented as required although the controllers treat them as optional | lists | mark them optional with `@ApiQuery({ required: false })` |
| PO, receipt and vendor bill have no generic `/actions` endpoint (the package assumed one); they expose explicit endpoints (`…/approve`, `…/send`, `…/receive`, `…/inspect`, `…/accept`, `…/match`, `…/schedule`) | po, grn, vendor_bill | none — the execution plans in T-27 use the explicit endpoints, never the approve ones |
| No endpoint lists vendor bills, and an inbox task carries the workflow state's name (`stateEn`) but not its code | home tile «فواتير موردين بانتظار المطابقة» (T-08) | a list endpoint for vendor bills with a status filter, and `stateCode` on the inbox task. Until then the tile counts inbox tasks with `documentType === 'VendorBill'` and `stateEn === 'Recorded'`, which is scoped to the caller's role and breaks if the state is renamed in NPI's workflow data |
| No call adds a milestone to an existing contract; milestones are accepted only inline at creation | customer_contract | none needed for the package — extraction must carry milestones before the create call |
| `CreateBillDto` carries only `goodsReceiptId` and `vendorRef`; amounts and lines are derived by NPI from the receipt | vendor_bill | none for the package — extracted totals are used for comparison in the preview, not sent |

| `ItemCategory` has only solar categories (MODULE, INVERTER, MOUNTING, CABLE, BOS, SPARE, SERVICE) | onboarding (T-14/T-15 item templates for general_contracting) | a generic category (e.g. `GENERAL`/`MATERIAL`); until then non-solar templates use `BOS` |
| `scm.procurement.write` covers creating purchase orders **and** receiving goods (`procurement.controller.ts` `createPo`, `receive`, `createBill` all require it) | onboarding (T-15 `equipment_trading`: role `warehouse_keeper`) | a separate receiving permission (e.g. `scm.receipt.write`) so a warehouse keeper can receive without being able to raise purchase orders — a segregation-of-duties gap; until then the pack grants `scm.procurement.write` to `warehouse_keeper` and the overlay/persona limit it to receiving by instruction only |

## Decisions needed (P1/P2/P3)
| # | Question | Recommended default | Priority | Status |
|---|---|---|---|---|
| D-1 | `ANTHROPIC_API_KEY` is missing from local `.env`. | Owner adds the line to `C:\dev\npi-erp\.env`. Work that runs on mocks (T-01…T-12) can proceed without it; the M1 gate, T-20, T-23 evals and every `@live` run cannot | P1 | **done 2026-10-03** — owner added the key; `COPILOT_PORT=3110` set at the same time. First real model calls made the same day (see Pending live verification) |
| D-2 | `02` §1 names `pdf-parse (MIT)`. The current release 2.4.5 is Apache-2.0 and a rewrite; the MIT line ends at 1.1.4 and is unmaintained. | Pin 2.4.5 (Apache-2.0 is permissive, no cost); read its types in `node_modules` before use (STEP 7) | P3 | open |
| D-3 | zod is new to the repo: 3.25.76 or 4.6.5? | 4.6.5 — accepted by the Anthropic SDK peer range, no existing major to match | P3 | open |
| D-4 | Rasterizing scanned PDFs with `pdfjs-dist` in Node needs a canvas implementation, a package the spec does not name. | Decide at T-21 after reading the pdfjs docs; report the package and licence before installing | P2 | open |
| D-5 | The 20 evaluation documents (F-20): owner-supplied with names removed, or synthetic? T-23 needs the 6 contracts. | Synthetic documents generated in the repo (Arabic, invented names, valid-format VAT numbers); owner-supplied ones are added later if provided | P2 | open |
| D-7 | The package refers to package 2.0 for parts it does not restate: tables `conversations`, `messages`, `redaction_sessions`, `eval_runs`, `daily_usage` (`02` §3), memory / pseudonymizer / audit / cost / metrics (`02` §8, T-09), NFRs (`02` §10), the OWASP list (`06` §2), the base Arabic strings and the Settings / Trust / Metrics screens (`03`), ADR-04/05/13/14/15/18/19. Package 2.0 is not in the repository and was not found under `C:dev` or the user folders searched. | Owner places the 2.0 files in `spec/madar-2.0/`. If they are not available: the implementer derives these parts from what 3.0 does state (F-12, F-16…F-19, AT-09, AT-10, AT-13, `09` 4.1 token form ⟦عميل_1⟧) and lists every derived choice under Deviations | P1 | **decided 2026-09-27** — owner wrote «موافق»; `spec/madar-2.0/` was not supplied, so the stated fallback applies: the parts are derived from 3.0 and each derived choice is listed under Deviations. If the 2.0 files are supplied later, the derived parts are reconciled against them |
| D-8 | NPI's OpenAPI document has empty schemas for 49 of its 59 request DTOs (LoginDto, CreateCustomerDto, CreateContractDto, CreatePoDto, ReceiveDto, CreateBillDto among them). Cause, confirmed on a temporary build that was reverted: the `@nestjs/swagger` plugin only reads files ending in `.dto.ts`, and most NPI DTO files are named `dto.ts`. With `dtoFileNameSuffix` extended the document has 69 schemas and none empty. | One-line change in `apps/api/nest-cli.json` (plugin option `dtoFileNameSuffix: [".dto.ts", ".entity.ts", "dto.ts"]`), on its own commit, then `npm run copilot:gen-types -- --fetch`. It changes the generated documentation only: no endpoint, validation or business logic changes. It is a change inside `apps/api`, so it waits for the owner | P1 | **done 2026-09-27** — owner wrote «موافق»; `69a02b4` (the one line), `fb0cb30` (types regenerated: 69 schemas, none empty). NPI unit 198/198, typecheck and lint green after it |
| D-9 | `npm audit --audit-level=high` reported 11 high and 1 critical finding on 2026-09-28; re-run on 2026-10-03 it reports 18 high and 1 critical (new advisories, same packages). All are in NPI's existing stack (`next` 14, `tailwindcss` 3, `@nestjs/cli` 10, `@nestjs/platform-express` 10, `@nestjs/swagger` and their transitive packages); the copilot pins the same majors NPI already uses (`next` 14.2.35, `tailwindcss` 3.4.19), so they hoist to the one root copy, and no finding has a path under `apps/copilot`. The fixes npm offers are major upgrades (Next 16, Tailwind 4, Nest 12). G-M1-6 asks for zero. | Keep ADR-26 (same majors) and treat G-M1-6 as "zero findings introduced by the copilot's own packages", checked at each gate by comparing against `main`; the upgrade of NPI's stack is a separate decision for the engineer | P2 | **decided 2026-10-03** — owner chose the recommendation (keep ADR-26; G-M1-6 = zero findings introduced by the copilot's own packages, compared against `main` at each gate; NPI's stack upgrade is a separate decision for the engineer) and wrote «موافق» for the M1 gate |
| D-10 | Port 3100, which the package names for the copilot on the owner's machine (`00` §4.7, `09` 1.1), is held on this machine by the container `tawazun-local-app-1` of another project. | The copilot now reads its port from `COPILOT_PORT` in the root `.env` (default 3100). Owner either stops that container while trying Madar, or adds `COPILOT_PORT=3110` to `.env` and opens `http://localhost:3110/copilot`. Nothing was changed in the other project | P2 | **done 2026-10-03** — owner chose `COPILOT_PORT=3110`; the copilot answers on `http://localhost:3110/copilot`. The other container was not touched |
| D-11 | The NPI sidebar renders every item with `next/link`. The new item points to `/copilot`, which is another application; Next.js advises a plain `<a>` for such links so that it does not try to prefetch and soft-navigate. Changing how the sidebar renders an item is more than the one nav link `02` §13 allows. | Decide at T-40, when the route exists and the behaviour can be seen: if the link misbehaves, allow a three-line change in `apps/web/src/app/(app)/layout.tsx` to render an `<a>` for an item marked external | P3 | open |
| D-12 | Two of the three suggestions shown in an empty chat («أرفق عقداً جديداً وسأُدخله», «طلب شراء: 40 لوح…») lead in M1 and M2 to the reply "entry by chat comes in a later milestone". The strings are canonical in `03` §4. | Keep them and show the one that already works first (done). Alternative: hide the two until M3 | P3 | open |
| D-6 | REJECT and RETURN on a requisition with an open signature chain still pass on the bare `scm.procurement.write` permission (`requisitions.service.ts` `act()`), leaving the chain PENDING and orphaned. Outside the Madar package; touches approval behaviour. | Separate branch `fix/pr-reject-return-chain` from `main`, own PR: REJECT with an open chain goes through `ApprovalService.decide(…,'REJECT')` (current step owner or delegate only); RETURN is allowed only to the current step owner and closes the chain so a resubmit opens a fresh one; the requester can do neither. Regression tests that fail before and pass after | P2 | open — waiting for the owner |

## Deviations from the package
| Task | What | Why | Reported (date) |
|---|---|---|---|
| T-00b | no migration `0021_numbering_year` | the fix needed no schema or data change | 2026-09-27 |
| T-00c | file path is `apps/api/src/modules/procurement/…`, not `apps/api/src/requisitions/…` | the plan's path does not exist | 2026-09-27 |
| T-00d | docs and login prefill are OFF on the demo server too | owner decision 2026-09-27; `05` T-00d said the demo keeps both | 2026-09-27 |
| T-02 | table `login_attempts` added to 0001_init; env is read from the repository-root `.env` (one file for the owner), `apps/copilot/.env.example` documents the variables | T-05 needs a DB-backed rate limit and names no migration; NPI already loads the root `.env` | 2026-09-27 |
| T-03 / T-04 | T-04 done before T-03 | T-03 is blocked on D-7 and T-04 does not depend on it | 2026-09-27 |
| T-03 (D-7) | `conversations`, `messages`, `redaction_sessions`, `eval_runs`, `daily_usage` are derived, not copied from 2.0: conversations carry org, user and position (BR-07); messages carry role, Arabic content, the tool/flow badge (F-03), the memory note (F-12) and `intakeJobId`; redaction sessions hold the token map encrypted; eval runs hold kind, score, pass flag and details; daily usage is one row per user per day with message count, tokens and cost in micro-USD | package 2.0 is not available (D-7, owner «موافق» 2026-09-27) | 2026-09-27 |
| T-03 | added table `consent_events`, column `intake_jobs.approvedAt`, tenant column `npiOrgId` on documents, intake jobs, memory facts, audit and usage, and a CHECK on `llm_audit` that an image is never marked sent without a consent id | `02` §5.3 and I4 need a consent event and T-22 names no migration; `02` §5.9 measures created→approved; tenancy must be enforced on every row | 2026-09-27 |
| T-03 | Arabic search uses `pg_trgm` and application-side normalization with the `simple` configuration; `unaccent` is not installed | `unaccent` does not fold Arabic letter variants, and a stemmer would mangle names and codes such as PRJ-00012 | 2026-09-27 |
| T-03 | `src/text/normalize.ts` created here rather than in T-10; extra migration `0003_position_role_only_unique` (T-39's index migration becomes 0004) | the search needs the normalizer; PostgreSQL treats NULL departments as distinct, so role-only positions needed a partial unique index | 2026-09-27 |
| T-06 | sixth persona file `default.md`; shared loader `src/prompts/load.ts`; readers in `src/npi/directory.ts` | NPI lets an admin create custom roles, and a role key from NPI data must never be turned into a file path; the loader is needed by every later prompt file | 2026-09-27 |
| T-07 (D-7) | `src/i18n/ar.ts` holds a derived base set (login, navigation, generic states, screen titles) next to the verbatim strings of `03` §4 | the 2.0 base strings are not available | 2026-09-27 |
| T-07 | the lint rule lives in `apps/copilot/eslint-rules/no-latin-ui-text.cjs` and is registered in the root `eslint.config.mjs`; `**/*.cjs` added to the lint ignores | the repository has one flat ESLint config at the root; CommonJS lets Jest load the rule with the standard `npm test` | 2026-09-27 |
| T-09 (D-7) | the pseudonymizer is a new design, not a port: Arabic placeholders ⟦عميل_1⟧ keyed by surface form; dictionary, pattern and session-learned detection; given-name lexicon in `src/privacy/names-ar.ts`; shared AES-GCM helper `src/crypto/aead.ts` | the 2.0 specification it was to be ported from is not available | 2026-09-27 |
| T-09 | a round trip is exact except that two spellings that normalize to the same text (شركه / شركة) share one placeholder and come back in the first spelling seen | one placeholder per surface keeps the model consistent; the difference is orthographic only | 2026-09-27 |
| T-10 | whole-word matcher `src/text/tokens.ts` added; never-execute requests (approve, reject, return, delete, cancel) go to the chat even with an attachment | substring matching refused «أفضل عرض فني» and read «معقد» as «عقد»; «احذف العقد» with an attachment would have started a contract entry | 2026-09-27 |
| T-11 | an entry request (contract, PR, PO, receipt, bill) is answered with a fixed text until the intake flows of M3 exist; extra files `src/agents/context.ts`, `src/privacy/dictionary.ts`, `prompts/memory-extract.md` | the assistant must not promise an entry it cannot perform yet; wiring and the name dictionary are kept apart from the turn logic so the turn is testable with fakes | 2026-09-27 |
| T-05 | `playwright.config.ts` created here, not in T-13; the e2e run uses its own ports and does not reuse running servers; `/login` sends a signed-in visitor home from the page, not from the middleware; `apps/copilot/scripts/run-next.mjs` reads the port from `COPILOT_PORT` | T-05's own verify step is a Playwright run; ports 3100/4000 may be busy and a reused API cannot be given the throttle override; a cookie can outlive its session and a redirect on its mere presence loops | 2026-09-27 |
| T-08 | three one-entry edits in `apps/web` (`nav.ts`, `messages.ts`, `icons.tsx`) instead of one | `02` §13 allows "one nav link"; the link needs its label and its icon to render. Nothing else in `apps/web` was touched | 2026-09-28 |
| T-12 | migration `0004_message_kind` (column `messages.kind`); navigation lists a screen only once it is built; attach and microphone buttons are shown disabled | a refusal or an error must still read as one after a reload; a link to a screen of a later milestone would lead to a 404; attachments and voice belong to M3 and M5 | 2026-09-28 |
| T-13 | the name dictionary is cached per list, not per organization; tool results mask the fields they know to be names as whole values | finding of the security review: the first caller after each expiry fixed the dictionary for the whole organization | 2026-09-28 |
| T-04 | root script `copilot:gen-types` changed to forward its arguments | `npm run copilot:gen-types -- --fetch` silently ran without `--fetch` | 2026-09-27 |
| STEP 2 | `PROGRESS.md` was copied and filled before STEP 5 | STEP 2 writes the inventory into it | 2026-09-27 |

| T-14 | `rolePermissionSets` values are `{ nameAr, nameEn?, permissions[] }`, not bare `permissions[]` | NPI's `CreateRoleDto` needs a display name to create a role the firm lacks (T-16) | 2026-10-03 |
| T-14 | `ppa_operator` lists module `procurement` in addition to `03` §5's five | the same table gives it «فاتورة مورد» and a PO ≥ 50k rule, both of which live in NPI's procurement module (`scm.procurement.*`) | 2026-10-03 |
| T-14 | `acceptedDocTypes[].flow` may be `null`; doc types without a flow are named only; the five flows stay the only flows (E.10) | «مستخلص» (T-15) exists in NPI's approval matrix but has no chat flow | 2026-10-03 |
| T-14 | Latin check on pack strings allows `EPC` besides `NPI` | `profile.epc` in `ar.ts` and `03` §5's «عقد EPC» are canonical and carry it; `ar.ts` already documents EPC/PPA/CSV as allowed codes | 2026-10-03 |
| T-14 | approval amounts in packs are whole SAR integers; `itemTemplates` carry no `unitCost`; extra file `src/onboarding/catalog.ts` and reader `src/npi/permissions.ts` | no decimals in reference data; prices belong to the firm; the loader needs the same key-only path safety as personas | 2026-10-03 |
| T-14/T-15 | `epc` and `general_contracting` list «طلب شراء» (flow `pr`) beyond `03` §5's doc-type column | the same table row gives each a PR approval default, which presupposes requisitions, and `pr` is one of the five flows | 2026-10-03 |
| T-15 | `engineering_consulting` lists module `procurement` in addition to `03` §5's four | same reason as `ppa_operator`: its «فاتورة مورد» flow and PO ≥ 20k rule live in NPI's procurement module | 2026-10-03 |
| T-15 | `MODULE_NAMES_AR` (Arabic module names) added to `profile.schema.ts`; `rolePermissionSets` gains roles `warehouse_keeper` and `engineer` not among the five `01` §2 roles | the overlays and the T-18 setup screens need Arabic names for hidden/visible modules; `03` §5 gives `equipment_trading` a warehouse department and `engineering_consulting` an engineering department with no matching role among the five. Personas for the two new roles fall back to `positions/default.md`; their pack `personaAr` is the position-specific text | 2026-10-03 |
| T-15 | overlays carry the pack's default approval thresholds | the brief asked for them as firm context; mitigated by the clause that the live NPI matrix governs (see M2 notes) | 2026-10-03 |

## Known limits (measured later)
- Names the pseudonymizer cannot know and that carry no title, no legal form and no known given name (for example a foreign name written in Arabic letters) pass through. The 100-sentence evaluation of T-32 measures this against the 90% / 95% targets.
- The assistant has not been run against a real model yet (D-1). Prompts `assistant.md`, `router.md` and `memory-extract.md` are untested in that sense.

## Suggestions (not implemented)
- `06` still cites NPI's suites as 187 unit / 25 integration; the current baseline is 198 / 31.

## Pending live verification
- **2026-10-03, first real model calls (D-1 closed).** Key present; `claude-haiku-4-5-20251001` on the economy tier answered every call, no provider error. `09` 1.1 login RTL, no prefill; 1.2 four tiles (all 0 locally); 1.3 «وش المهام اللي تنتظرني؟» → tool `list_open_tasks`, reply "no tasks" (matches `/inbox`); 1.4 «شروط سداد عميل مصنع الرياض للصناعات؟» → `memory_search` + `get_customer`, reply "30 يوم" (correct); 1.5 refused with zero model calls. `llm_audit.outboundRedactedText` checked on all six calls: customer name, VAT number, phone and email left as ⟦عميل_1⟧ ⟦رقم_ضريبي_1⟧ ⟦هاتف_1⟧ ⟦بريد_1⟧; «مهندس» went out as ⟦موظف_1⟧ (over-redaction, safe). Tokens 2.6k–3.3k in / 29–140 out per call, 1.0–1.5 s latency, ≈0.003 USD per call. `output_config.format` was not exercised: no JSON-schema call happens in M1.
- Finding fixed the same day: the model answered 1.4 with Markdown (`**30 يوماً**`) and `Message.tsx` renders plain text, so the asterisks would have shown. One rule added to `prompts/assistant.md` ("plain text, no Markdown"); re-run of 1.4 came back plain. Lint, tsc and jest 579/579 green after the change.
- Observation, not a defect: `09` 1.4 expects «ملاحظة من الذاكرة». Memory notes come only from facts the employee stated earlier (`prompts/memory-extract.md`); on a fresh database `memory_search` returns nothing, so the badge «الذاكرة» shows but no note. The owner should state a fact first (e.g. a payment term agreed with a customer) and ask again.
- The fixed `verify()` in `deploy/deploy.sh` (PR #7) has not yet run inside a full deploy; the next deploy is its first real run. After it, confirm the server's `deploy/.deploy_history` kept its earlier lines.
- The demo server runs build `4756ba6`; `main` is ahead by deploy scripts and comments only.

## Owner-facing summary (Arabic)
**2026-10-03 (ليلاً) — T-15 منجزة.** أُكملت حزم النشاط الست: أُضيفت حزم «مقاولات عامة» و«تجارة معدات» و«استشارات هندسية» بأدوارها (أمين المستودع، مهندس) وسقوفها الافتراضية من المواصفة، وستة تراكبات عربية تشرح للمساعد طبيعة كل منشأة ومستنداتها ومصطلحاتها والوحدات غير الظاهرة لها. الاختبارات 690/690، والفحص الحي يثبت أن كل صلاحية في الحزم الست موجودة في NPI المحلي. ملاحظتان للمهندس دُوّنتا في فجوات NPI: لا فئة أصناف عامة (مواد البناء تحت BOS)، وصلاحية المشتريات الواحدة تغطي إنشاء أمر الشراء والاستلام معاً (فصل مهام). التالي: T-16 (خطة التطبيق على NPI والفروق) للنموذج الرئيسي.

**2026-10-03 (مساءً) — اعتماد المرحلة ١.** قرّر المالك D-9 بالخيار الأول (إبقاء ADR-26، وقراءة G-M1-6 على أنها «صفر تحذيرات أدخلتها حزم مَدار نفسها» بالمقارنة مع `main` في كل بوابة؛ ترقية حزم NPI قرار منفصل للمهندس) وكتب «موافق». أُنشئ الوسم `copilot-v0.1.0` محلياً على `feat/copilot` (بلا دفع). تبدأ المرحلة ٢ «التشكّل حسب النشاط» من T-14 في جلسة جديدة؛ T-16 للنموذج الرئيسي.

**2026-10-03 — أول اتصال حقيقي بالنموذج.** أضاف المالك المفتاح وضبط المنفذ 3110، فجُرّبت الخطوات 1.1 إلى 1.5 من سيناريو `09` على التشغيل المحلي: الدخول والبطاقات الأربع، وسؤال المهام (أجاب من صندوق المهام بلا مهام مطابقاً لـ NPI)، وشروط سداد «مصنع الرياض للصناعات» (30 يوماً، صحيحة)، ورفض سؤال التقييم بلا أي اتصال. سجل التدقيق يثبت أن لا اسم ولا رقم ضريبي ولا هاتف ولا بريد خرج إلى المزوّد. عيب واحد وجد وأُصلح: الرد جاء بتنسيق Markdown والواجهة تعرض النص خاماً، فأُضيفت قاعدة «نص خام» إلى البرومبت وأُعيدت التجربة. ملاحظة: «ملاحظة من الذاكرة» في 1.4 تظهر فقط بعد أن يذكر الموظف حقيقة تُحفظ؛ قاعدة البيانات المحلية خالية منها. ينتظر: قرارك في D-9 ثم «موافق» (الخطوة 1.6 تعمل بعد T-40 كما هو مدوّن).

**2026-09-28 — بوابة المرحلة ١.** أُنجزت المهام T-01 إلى T-13 على الفرع `feat/copilot` المحلي. الموظف يدخل مَدار بحساب NPI، يرى أربع بطاقات من NPI بصلاحياته، ويحادث. سؤال تقييم الموظفين يُرفض بلا أي اتصال بنموذج، وطلب الإدخال يُعرَف ويُردّ عليه بنص ثابت حتى المرحلة ٣. اختبارات الطبقة 579، اختبارات المتصفح 72/72، اختبارات NPI ‏198 وحدة و31 تكامل، وبناء NPI ناجح. المراجعة الأمنية ومراجعة الكود ومراجعة التصميم أُجريت وأُصلحت ملاحظاتها. **لم يُجرَ أي اتصال بنموذج حقيقي** لغياب المفتاح (D-1). ينتظر قرارك: D-1، D-9، D-10، وموافقتك على المرحلة بعد تنفيذ سيناريو `09`.

**2026-09-27 — بداية المرحلة ١.** بعد «موافق» نُفّذت T-01 (هيكل التطبيق) وT-02 (قاعدة `npi_copilot` وحارسها) وT-04 (عميل واجهة NPI). اختبارات الطبقة 38/38 واختبارات NPI 198/198. T-03 متوقفة على القرار D-7 (حزمة 2.0 غير موجودة في المستودع). القرار D-8: وثيقة واجهة NPI تصف 10 من 59 هيكل إدخال فقط، وإصلاحها سطر واحد في إعداد `apps/api` ينتظر إذنك. المفتاح `ANTHROPIC_API_KEY` ما زال غائباً.
