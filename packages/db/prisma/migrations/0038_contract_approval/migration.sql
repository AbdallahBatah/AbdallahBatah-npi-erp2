-- Package 2 · P2-2 (ADR-01 as amended 2026-10-29) — the contract is signed once
-- by the general manager before it can be activated (owner work cycle step 9:
-- the accepted offer's approval IS the contract's approval).
--
--   ContractStatus   += PENDING_APPROVAL, APPROVED   (DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE)
--   ApprovalDocument += CONTRACT                     (the matrix bands contracts on their value)
--   Contract         += submittedAt, approvedAt, approvedById, activatedAt
--
-- ADD VALUE only (no stored row changes meaning) and nullable columns. The new
-- values are not used in this file — Postgres refuses a value added in the same
-- transaction; 0039 seeds the approval rules. Down: down.sql.

ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL' AFTER 'DRAFT';
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'APPROVED' AFTER 'PENDING_APPROVAL';
ALTER TYPE "ApprovalDocument" ADD VALUE IF NOT EXISTS 'CONTRACT';

ALTER TABLE "Contract"
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "activatedAt" TIMESTAMP(3);
