# 04 — Architecture Decision Records (Delta)
**Project:** Madar — Conversational layer for NPI ERP | **Package version:** 3.0 | **Date:** 2026-09-21
Format: Decision / Alternatives rejected / Reason / Impact. ★ = costly to change later. ADR-04 (branded redaction gate), ADR-05/19 (single provider), ADR-13 (Arabic tokens), ADR-14 (prompt files), ADR-15 (voice), ADR-18 (position agents) carry over from earlier packages.

**ADR-24 ★ The copilot is a client of NPI's HTTP API acting as the logged-in user — never a database writer, never a service account.** Rejected: direct Prisma access to `npi`; an admin/service token; a NestJS module inside `apps/api`. Reason: inherits the fail-closed permission guard, tenant isolation, approval matrix, workflow engine and audit for free; makes "no bypass, even for the owner" structural. Impact: everything the copilot does is expressible as API calls; API gaps become backlog items, not shortcuts.

**ADR-25 ★ Separate app `apps/copilot` in the monorepo with its own PostgreSQL database `npi_copilot`.** Rejected: SQLite (second storage tech, backup divergence), tables inside `npi` (couples to NPI schema and migrations), a separate repo (loses shared tooling/deploy). Reason: one Postgres, one backup, one deploy pipeline; zero risk to NPI's schema. Impact: startup guard on DB name; own Prisma schema and migrations.

**ADR-26 ★ Same major versions as the existing repo (Next 14.2, Tailwind 3, Prisma 5.22, Jest).** Rejected: Next 16/Tailwind 4 for the new app. Reason: npm workspaces hoisting and one toolchain; avoids two Next majors in one install. Impact: newer features unavailable; revisit when NPI upgrades.

**ADR-27 ★ Document intake policy: local text extraction + redaction for text PDFs; explicit per-document consent and audit for images/scans; confidential-tagged documents never sent.** Rejected: always send raw documents; local Arabic OCR (B-04). Reason: owner decision (Q3, 2026-09-21); transparency and audit are the practical substitute where redaction is impossible. Impact: `ConsentCard`, `llm_audit.imageSent`, policy line verified in Phase 0.

**ADR-28 Extraction returns strict JSON validated against schemas that mirror NPI DTOs (generated from OpenAPI), with per-field confidence and evidence.** Rejected: free-text extraction then parsing; letting the model call NPI directly. Reason: deterministic preview; critical fields validated server-side; NPI's own validation is the last gate. Impact: prompts per flow; zod schemas per flow.

**ADR-29 Execution is an ordered sequence of NPI calls with stop-on-failure and no automatic retry of writes.** Rejected: pseudo-transactions with compensating deletes. Reason: NPI has no cross-endpoint transaction; automatic deletes on a financial system are riskier than a clear partial report. Impact: `ExecutionCard` shows created ids; user finishes or cancels in NPI.

**ADR-30 ★ Activity shaping applies only what NPI's admin API allows, and lists the rest as gaps.** Rejected: seeding NPI tables from the copilot; forking NPI config into the copilot. Reason: BR-08; keeps NPI the single source of configuration. Impact: `npiApiGapsJson`; workflow definitions remain seed-only (B-02).

**ADR-31 Phase 0 fixes two NPI defects before the layer is built (numbering at year boundary; PR approve bypass).** Rejected: build first, fix later. Reason: the layer accelerates input and must not accelerate a bypass; numbering failure on 1 Jan 2027 would break every flow. Impact: T-00b/T-00c with regression tests.

**ADR-32 Deploy as a fifth service in the existing prod compose behind Caddy `/copilot`.** Rejected: separate host; owner's Docker machine. Reason: must reach `api` on the internal network; reuse rolling deploy and backup. Impact: `deploy.sh`, `backup.sh`, demo-reset extended, not rewritten.
