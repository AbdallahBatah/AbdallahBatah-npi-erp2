-- A position is (organization, role, department). The unique index from
-- 0001_init covers rows that have a department, but PostgreSQL treats NULLs
-- as distinct, so two concurrent first logins of the same role with no
-- department could each insert a "role only" position. This partial index
-- closes that gap. Prisma cannot express a partial index, so it lives only
-- here (see the note on model Position in schema.prisma).
CREATE UNIQUE INDEX "positions_npiOrgId_roleKey_nodept_key"
  ON "positions"("npiOrgId", "roleKey")
  WHERE "departmentId" IS NULL;
