-- CRM Phase 1 · Step 2 (§4.1) — the unified customer record.
--
-- `Customer` stays THE customer table. This migration adds to it what a single
-- record of a customer needs: whether it is a company or a person, a canonical
-- mobile number, the normalised Arabic name that duplicate matching compares,
-- and the pointer a merged-away duplicate keeps to the record that survived.
-- It also adds the contacts table, the merge log, and the per-organization
-- settings table the merge switch lives in.
--
-- Additive only: no existing column, table or enum value is altered or removed.
-- Every new column on `Customer` is nullable or defaulted, so the code that was
-- running before this migration keeps working against the new schema.
--
-- UNIQUENESS IS NOT ENFORCED HERE. The indexes below are plain, not unique:
-- the live data may already hold duplicates, and a unique index would refuse
-- to build over them and take the deploy down with it. The partial UNIQUE
-- indexes are migration 0023, applied after the duplicates have been merged.
--
-- Two SQL functions are created and KEPT: `npi_normalize_arabic_name` and
-- `npi_normalize_saudi_mobile`. They are the SQL twins of `normalizeArabicName`
-- and `normalizeSaudiMobile` in packages/shared/src/arabic.ts and are used for
-- the back-fill below. An integration test runs both implementations over a
-- list of names and requires identical output; change one, change the other.

-- CreateEnum
CREATE TYPE "CustomerEntityKind" AS ENUM ('COMPANY', 'INDIVIDUAL');

-- AlterEnum: attachments may now hang off a customer. ADD VALUE only — no
-- stored row changes meaning. (The value is not used inside this migration.)
ALTER TYPE "AttachmentEntity" ADD VALUE IF NOT EXISTS 'CUSTOMER';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "entityKind" "CustomerEntityKind" NOT NULL DEFAULT 'COMPANY',
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "mobile" TEXT,
ADD COLUMN     "nameNormalized" TEXT;

-- CreateTable
CREATE TABLE "CustomerContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMergeLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "survivorId" TEXT NOT NULL,
    "mergedId" TEXT NOT NULL,
    "movedJson" JSONB NOT NULL,
    "mergedSnapshotJson" JSONB NOT NULL,
    "backupRef" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerMergeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerContact_organizationId_customerId_idx" ON "CustomerContact"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "CustomerMergeLog_organizationId_survivorId_idx" ON "CustomerMergeLog"("organizationId", "survivorId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgSetting_organizationId_key_key" ON "OrgSetting"("organizationId", "key");

-- CreateIndex: the merge moves every Contract and Invoice of the duplicate; without
-- these it would scan both tables once per merged customer.
CREATE INDEX "Contract_customerId_idx" ON "Contract"("customerId");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex: duplicate lookups (non-unique — see the header).
CREATE INDEX "Customer_organizationId_crNumber_idx" ON "Customer"("organizationId", "crNumber");

-- CreateIndex
CREATE INDEX "Customer_organizationId_vatNumber_idx" ON "Customer"("organizationId", "vatNumber");

-- CreateIndex
CREATE INDEX "Customer_organizationId_mobile_idx" ON "Customer"("organizationId", "mobile");

-- CreateIndex
CREATE INDEX "Customer_organizationId_nameNormalized_idx" ON "Customer"("organizationId", "nameNormalized");

-- CreateIndex
CREATE INDEX "Customer_mergedIntoId_idx" ON "Customer"("mergedIntoId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerContact" ADD CONSTRAINT "CustomerContact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMergeLog" ADD CONSTRAINT "CustomerMergeLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgSetting" ADD CONSTRAINT "OrgSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── SQL twins of packages/shared/src/arabic.ts ─────────────────────────────

-- normalizeArabicName, step for step:
--   1 ASCII A-Z -> a-z            2 drop tashkeel / superscript alef / tatweel
--   3 fold letters + digits       4 drop "."
--   5 anything but a-z 0-9 Arabic letters -> space
--   6 collapse + trim spaces      7 drop the article "ال" from each word that
--                                   keeps two or more letters after it
-- Arabic letters are written as \uXXXX escapes (regex) and U&'..' strings
-- (translate) so this file is immune to editor / encoding accidents.
CREATE FUNCTION "npi_normalize_arabic_name"(input TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  s TEXT := coalesce(input, '');
BEGIN
  s := translate(s, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
  s := regexp_replace(s, '[ً-ٰٟـ]', '', 'g');
  -- أ إ آ ٱ ة ى ؤ ئ  then ٠-٩ then ۰-۹
  s := translate(
    s,
    U&'\0623\0625\0622\0671\0629\0649\0624\0626\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9',
    U&'\0627\0627\0627\0627\0647\064A\0648\064A' || '01234567890123456789'
  );
  s := regexp_replace(s, '\.', '', 'g');
  s := regexp_replace(s, '[^a-z0-9ء-ي ]', ' ', 'g');
  s := btrim(regexp_replace(s, ' +', ' ', 'g'), ' ');
  s := regexp_replace(s, '(^| )ال(?=[^ ]{2})', '\1', 'g');
  RETURN s;
END
$fn$;

-- normalizeSaudiMobile: +9665xxxxxxxx, or NULL when it is not a Saudi mobile.
-- Accepts 05xxxxxxxx, 5xxxxxxxx, 9665xxxxxxxx, +9665xxxxxxxx, 009665xxxxxxxx.
CREATE FUNCTION "npi_normalize_saudi_mobile"(input TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  s TEXT;
  m TEXT[];
BEGIN
  IF input IS NULL OR input = '' THEN
    RETURN NULL;
  END IF;
  s := translate(
    input,
    U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9',
    '01234567890123456789'
  );
  s := regexp_replace(s, '[ \t\r\n().-]', '', 'g');
  m := regexp_match(s, '^(?:\+?966|00966|0)?(5[0-9]{8})$');
  IF m IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN '+966' || m[1];
END
$fn$;

-- ── Data ───────────────────────────────────────────────────────────────────

-- Every existing customer gets its normalised name.
UPDATE "Customer" SET "nameNormalized" = "npi_normalize_arabic_name"("nameAr");

-- `mobile` is inferred from the free-text `phone` ONLY when it is a Saudi
-- mobile; otherwise it stays NULL and `phone` is left exactly as it was.
UPDATE "Customer" SET "mobile" = "npi_normalize_saudi_mobile"("phone") WHERE "phone" IS NOT NULL;

-- The two settings Step 2 reads, written explicitly for every existing
-- organization so that switching the merge on is a one-line UPDATE of a row
-- that is visibly there, not an INSERT someone has to know the shape of.
-- Absent rows fall back to the same defaults in code (OrgSettingsService).
INSERT INTO "OrgSetting" ("id", "organizationId", "key", "valueJson", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'crm.customer.similarityThreshold', '0.8'::jsonb, CURRENT_TIMESTAMP
FROM "Organization" o
ON CONFLICT ("organizationId", "key") DO NOTHING;

INSERT INTO "OrgSetting" ("id", "organizationId", "key", "valueJson", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'crm.customer.mergeEnabled', 'false'::jsonb, CURRENT_TIMESTAMP
FROM "Organization" o
ON CONFLICT ("organizationId", "key") DO NOTHING;
