-- T-48b (D-26): the sixth flow, an administrative one (a user's permission overrides).
-- Additive only: one enum value; no table or column changes.
ALTER TYPE "FlowType" ADD VALUE 'user_permissions';
