-- T-47b: the NPI-vs-Madar sync keeps one row per attempt that read NPI (or was
-- refused for a reason an administrator can act on). Additive only: a new
-- table and one index; firm_config's lastSync* columns came with 0010.
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "npiOrgId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byNpiUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "diffJson" JSONB,
    "namesJson" JSONB,
    "skipped" TEXT,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sync_runs_npiOrgId_at_idx" ON "sync_runs"("npiOrgId", "at");
