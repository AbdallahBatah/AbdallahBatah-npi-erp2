DELETE FROM "NumberingSequence" WHERE "documentType" IN ('EXECUTION_OVERRUN', 'MATERIAL_RETURN');
DROP TABLE IF EXISTS "MaterialReturnLine";
DROP TABLE IF EXISTS "MaterialReturn";
DROP TABLE IF EXISTS "SiteAttendance";
DROP TABLE IF EXISTS "ExecutionOverrun";
DROP TABLE IF EXISTS "WorkProgressEntry";
DROP TYPE IF EXISTS "MaterialReturnStatus";
DROP TYPE IF EXISTS "OverrunStatus";
-- The 'EXECUTION_OVERRUN' value stays on "ApprovalDocument": Postgres cannot drop an enum value.
-- Remove its rules first (0044 down) if rolling back both.
