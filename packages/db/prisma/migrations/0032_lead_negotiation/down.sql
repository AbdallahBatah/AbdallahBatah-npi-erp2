-- Reverses 0032_lead_negotiation.
--
--   psql "$DATABASE_URL" -f down.sql
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '0032_lead_negotiation';
--
-- Run it before rolling the containers back to an image older than P3-1.
-- Statuses map back NEGOTIATING -> NEW, ACCEPTED -> CONVERTED,
-- REJECTED -> DISQUALIFIED (QUALIFIED cannot be recovered: it was folded into
-- NEGOTIATING). The address, site, rejection reason and notes are dropped; each
-- change left a row in "AuditLog", which this does not touch.

ALTER TABLE "Lead" DROP CONSTRAINT IF EXISTS "Lead_rejectionReasonId_fkey";
DROP INDEX IF EXISTS "Lead_rejectionReasonId_idx";
ALTER TABLE "Lead"
  DROP COLUMN IF EXISTS "address",
  DROP COLUMN IF EXISTS "siteLocation",
  DROP COLUMN IF EXISTS "siteLat",
  DROP COLUMN IF EXISTS "siteLng",
  DROP COLUMN IF EXISTS "rejectionReasonId",
  DROP COLUMN IF EXISTS "rejectionNotes",
  DROP COLUMN IF EXISTS "statusChangedAt";

ALTER TYPE "LeadStatus" RENAME TO "LeadStatus_new";
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED');
ALTER TABLE "Lead" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Lead" ALTER COLUMN "status" TYPE "LeadStatus" USING (
  CASE "status"::text
    WHEN 'ACCEPTED' THEN 'CONVERTED'
    WHEN 'REJECTED' THEN 'DISQUALIFIED'
    ELSE 'NEW'
  END
)::"LeadStatus";
ALTER TABLE "Lead" ALTER COLUMN "status" SET DEFAULT 'NEW';
DROP TYPE "LeadStatus_new";
