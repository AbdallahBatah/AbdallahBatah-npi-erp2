-- T-47a: automatic setup. The wizard now reads the answers from NPI and the
-- administrator only confirms them; firm_config records which way the setup
-- was reached and the evidence behind it. Existing rows were typed by hand,
-- hence the 'manual' default. The three lastSync* columns are reserved for
-- T-47b (the NPI-vs-Madar sync) and stay NULL until then. Nothing is dropped.
ALTER TABLE "firm_config" ADD COLUMN "setupSource" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "firm_config" ADD COLUMN "discoveryJson" JSONB;
ALTER TABLE "firm_config" ADD COLUMN "lastSyncAt" TIMESTAMP(3);
ALTER TABLE "firm_config" ADD COLUMN "lastSyncDiffJson" JSONB;
ALTER TABLE "firm_config" ADD COLUMN "lastSyncSeenAt" TIMESTAMP(3);
