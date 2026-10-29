-- Package 3 · P3-8 (ADR-03 §4-6, owner work cycle step 8) — files may hang off
-- a proposal: accepting a quote now requires the customer's written approval,
-- uploaded to the proposal after it was sent. ADD VALUE only: no stored row
-- changes meaning.

ALTER TYPE "AttachmentEntity" ADD VALUE IF NOT EXISTS 'PROPOSAL';
