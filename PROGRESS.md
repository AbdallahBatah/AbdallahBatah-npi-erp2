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
| T-01 | done | (this commit) | M1 — copilot:build, typecheck, lint green; NPI unit 198/198. Font comes from next/font/google exactly as apps/web does (no font files exist in the repo to copy) |
| T-02 | done | (this commit) | M1 — `npi_copilot` created by `prisma migrate deploy`, 0001_init applied, second run idempotent; db-guard 11/11. NPI database is named `npi_erp` (the spec says `npi`): the guard is an allow-list so both are refused. Client generated to `src/generated/prisma` so NPI's client is never overwritten. Added table `login_attempts` here for T-05's DB rate limit |
| T-03 | todo | | M1 |
| T-04 | todo | | M1 — needs the API started with `EXPOSE_API_DOCS=1` to fetch the spec |
| T-05 | todo | | M1 |
| T-06 | todo | | M1 |
| T-07 | todo | | M1 |
| T-08 | todo | | M1 — the only allowed edit in `apps/web` (`src/lib/nav.ts`, file exists) |
| T-09 | todo | | M1 |
| T-10 | todo | | M1 |
| T-11 | todo | | M1 [HIGHER MODEL] |
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
| D-6 | REJECT and RETURN on a requisition with an open signature chain still pass on the bare `scm.procurement.write` permission (`requisitions.service.ts` `act()`), leaving the chain PENDING and orphaned. Outside the Madar package; touches approval behaviour. | Separate branch `fix/pr-reject-return-chain` from `main`, own PR: REJECT with an open chain goes through `ApprovalService.decide(…,'REJECT')` (current step owner or delegate only); RETURN is allowed only to the current step owner and closes the chain so a resubmit opens a fresh one; the requester can do neither. Regression tests that fail before and pass after | P2 | open — waiting for the owner |

## Deviations from the package
| Task | What | Why | Reported (date) |
|---|---|---|---|
| T-00b | no migration `0021_numbering_year` | the fix needed no schema or data change | 2026-09-27 |
| T-00c | file path is `apps/api/src/modules/procurement/…`, not `apps/api/src/requisitions/…` | the plan's path does not exist | 2026-09-27 |
| T-00d | docs and login prefill are OFF on the demo server too | owner decision 2026-09-27; `05` T-00d said the demo keeps both | 2026-09-27 |
| T-02 | table `login_attempts` added to 0001_init; env is read from the repository-root `.env` (one file for the owner), `apps/copilot/.env.example` documents the variables | T-05 needs a DB-backed rate limit and names no migration; NPI already loads the root `.env` | 2026-09-27 |
| STEP 2 | `PROGRESS.md` was copied and filled before STEP 5 | STEP 2 writes the inventory into it | 2026-09-27 |

## Suggestions (not implemented)
- `06` still cites NPI's suites as 187 unit / 25 integration; the current baseline is 198 / 31.

## Pending live verification
- The fixed `verify()` in `deploy/deploy.sh` (PR #7) has not yet run inside a full deploy; the next deploy is its first real run. After it, confirm the server's `deploy/.deploy_history` kept its earlier lines.
- The demo server runs build `4756ba6`; `main` is ahead by deploy scripts and comments only.

## Owner-facing summary (Arabic)
**2026-09-27 — التشغيل الأول، الخطوات 1–4.** قُرئت الحزمة كاملة وتقرير المرحلة صفر. خط الأساس على `main` أخضر: 198 اختبار وحدة و31 اختبار تكامل. أُنشئ الفرع `feat/copilot`. الخطة خمس مراحل بـ46 مهمة (13 · 7 · 11 · 6 · 9). المهام الأربع ذات النموذج الأعلى (T-11، T-16، T-23، T-27) ينفّذها النموذج الرئيسي نفسه، والباقي وكلاء Sonnet 5 بمراجعة النموذج الرئيسي. لم يبدأ التنفيذ: ينتظر «موافق». المفتاح `ANTHROPIC_API_KEY` ما زال غائباً عن `.env`. ست قرارات مفتوحة في جدول «Decisions needed».
