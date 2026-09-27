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
| T-05 | todo | | M1 |
| T-06 | done | a73f1bb | M1 — positions 41/41 (fakes; a type-level check proves the real Prisma client fits). Resolution order: own open assignment for the current role, then NPI directory when the user holds `admin.department.manage`, then role alone. Six persona files (five roles + `default`) |
| T-07 | done | 5065584 | M1 — i18n 6/6, lint rule 14/14, `eslint .` clean for the whole repository, tsc clean, copilot build green. Screens that use the shell arrive with T-08/T-12; `design-critic` reviews them before the gate |
| T-08 | todo | | M1 — the only allowed edit in `apps/web` (`src/lib/nav.ts`, file exists) |
| T-09 | done | 590fbc0 | M1 — aead 21, llm 40, llm-db 2 (real database), pseudonymizer 82. Prices re-verified on the official pricing page 2026-09-27 (Haiku 4.5 $1/$5, Sonnet 5 $2/$10 per MTok). Reviewer probed the gate with realistic sentences and sent it back once for leaks (bare organization name, parts of employee names, family name, names without a title); fixed and re-probed. No real model call was made: no API key |
| T-10 | done | def9e46 | M1 — router 45, hr-guard 53, tokens 19. Reviewer replaced substring matching with whole-word matching (`src/text/tokens.ts`) after finding ordinary sentences refused or misrouted |
| T-11 | in-progress | 2842783 | M1 [HIGHER MODEL] — done by the main model. Turn logic, tools, memory, dictionary and prompts committed: agents 30, agents-tools 23, memory 24 (real database). `src/app/api/chat/route.ts` is written and waits for T-05 (it needs the session). Not yet exercised against a real model: no API key (D-1) |
| T-12 | todo | | M1 |
| T-13 | todo | | M1 gate |
| T-14 | todo | | M2 |
| T-15 | todo | | M2 |
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
### M2
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
| No call adds a milestone to an existing contract; milestones are accepted only inline at creation | customer_contract | none needed for the package — extraction must carry milestones before the create call |
| `CreateBillDto` carries only `goodsReceiptId` and `vendorRef`; amounts and lines are derived by NPI from the receipt | vendor_bill | none for the package — extracted totals are used for comparison in the preview, not sent |

## Decisions needed (P1/P2/P3)
| # | Question | Recommended default | Priority | Status |
|---|---|---|---|---|
| D-1 | `ANTHROPIC_API_KEY` is missing from local `.env`. | Owner adds the line to `C:\dev\npi-erp\.env`. Work that runs on mocks (T-01…T-12) can proceed without it; the M1 gate, T-20, T-23 evals and every `@live` run cannot | P1 | open |
| D-2 | `02` §1 names `pdf-parse (MIT)`. The current release 2.4.5 is Apache-2.0 and a rewrite; the MIT line ends at 1.1.4 and is unmaintained. | Pin 2.4.5 (Apache-2.0 is permissive, no cost); read its types in `node_modules` before use (STEP 7) | P3 | open |
| D-3 | zod is new to the repo: 3.25.76 or 4.6.5? | 4.6.5 — accepted by the Anthropic SDK peer range, no existing major to match | P3 | open |
| D-4 | Rasterizing scanned PDFs with `pdfjs-dist` in Node needs a canvas implementation, a package the spec does not name. | Decide at T-21 after reading the pdfjs docs; report the package and licence before installing | P2 | open |
| D-5 | The 20 evaluation documents (F-20): owner-supplied with names removed, or synthetic? T-23 needs the 6 contracts. | Synthetic documents generated in the repo (Arabic, invented names, valid-format VAT numbers); owner-supplied ones are added later if provided | P2 | open |
| D-7 | The package refers to package 2.0 for parts it does not restate: tables `conversations`, `messages`, `redaction_sessions`, `eval_runs`, `daily_usage` (`02` §3), memory / pseudonymizer / audit / cost / metrics (`02` §8, T-09), NFRs (`02` §10), the OWASP list (`06` §2), the base Arabic strings and the Settings / Trust / Metrics screens (`03`), ADR-04/05/13/14/15/18/19. Package 2.0 is not in the repository and was not found under `C:dev` or the user folders searched. | Owner places the 2.0 files in `spec/madar-2.0/`. If they are not available: the implementer derives these parts from what 3.0 does state (F-12, F-16…F-19, AT-09, AT-10, AT-13, `09` 4.1 token form ⟦عميل_1⟧) and lists every derived choice under Deviations | P1 | **decided 2026-09-27** — owner wrote «موافق»; `spec/madar-2.0/` was not supplied, so the stated fallback applies: the parts are derived from 3.0 and each derived choice is listed under Deviations. If the 2.0 files are supplied later, the derived parts are reconciled against them |
| D-8 | NPI's OpenAPI document has empty schemas for 49 of its 59 request DTOs (LoginDto, CreateCustomerDto, CreateContractDto, CreatePoDto, ReceiveDto, CreateBillDto among them). Cause, confirmed on a temporary build that was reverted: the `@nestjs/swagger` plugin only reads files ending in `.dto.ts`, and most NPI DTO files are named `dto.ts`. With `dtoFileNameSuffix` extended the document has 69 schemas and none empty. | One-line change in `apps/api/nest-cli.json` (plugin option `dtoFileNameSuffix: [".dto.ts", ".entity.ts", "dto.ts"]`), on its own commit, then `npm run copilot:gen-types -- --fetch`. It changes the generated documentation only: no endpoint, validation or business logic changes. It is a change inside `apps/api`, so it waits for the owner | P1 | **done 2026-09-27** — owner wrote «موافق»; `69a02b4` (the one line), `fb0cb30` (types regenerated: 69 schemas, none empty). NPI unit 198/198, typecheck and lint green after it |
| D-9 | `npm audit --audit-level=high` reports 11 high and 1 critical finding, all in NPI's existing stack (`next` 14, `@nestjs/cli`, `@nestjs/platform-express`, `@nestjs/swagger` and their transitive packages); none comes from a package the copilot added. The fixes npm offers are major upgrades (Next 16, Nest 12). G-M1-6 asks for zero. | Keep ADR-26 (same majors) and treat G-M1-6 as "zero findings introduced by the copilot's own packages", checked at each gate by comparing against `main`; the upgrade of NPI's stack is a separate decision for the engineer | P2 | open — needed before the M1 gate can be declared passed |
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
| T-04 | root script `copilot:gen-types` changed to forward its arguments | `npm run copilot:gen-types -- --fetch` silently ran without `--fetch` | 2026-09-27 |
| STEP 2 | `PROGRESS.md` was copied and filled before STEP 5 | STEP 2 writes the inventory into it | 2026-09-27 |

## Known limits (measured later)
- Names the pseudonymizer cannot know and that carry no title, no legal form and no known given name (for example a foreign name written in Arabic letters) pass through. The 100-sentence evaluation of T-32 measures this against the 90% / 95% targets.
- The assistant has not been run against a real model yet (D-1). Prompts `assistant.md`, `router.md` and `memory-extract.md` are untested in that sense.

## Suggestions (not implemented)
- `06` still cites NPI's suites as 187 unit / 25 integration; the current baseline is 198 / 31.

## Pending live verification
- The fixed `verify()` in `deploy/deploy.sh` (PR #7) has not yet run inside a full deploy; the next deploy is its first real run. After it, confirm the server's `deploy/.deploy_history` kept its earlier lines.
- The demo server runs build `4756ba6`; `main` is ahead by deploy scripts and comments only.

## Owner-facing summary (Arabic)
**2026-09-27 — بداية المرحلة ١.** بعد «موافق» نُفّذت T-01 (هيكل التطبيق) وT-02 (قاعدة `npi_copilot` وحارسها) وT-04 (عميل واجهة NPI). اختبارات الطبقة 38/38 واختبارات NPI 198/198. T-03 متوقفة على القرار D-7 (حزمة 2.0 غير موجودة في المستودع). القرار D-8: وثيقة واجهة NPI تصف 10 من 59 هيكل إدخال فقط، وإصلاحها سطر واحد في إعداد `apps/api` ينتظر إذنك. المفتاح `ANTHROPIC_API_KEY` ما زال غائباً.
