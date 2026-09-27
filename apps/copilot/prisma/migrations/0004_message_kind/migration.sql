-- What kind of reply an assistant message is (answer, hr_refusal,
-- flow_pending, error), so that a refusal or an error still looks like one
-- when the conversation is loaded again. NULL for user messages and for
-- rows written before this migration.
ALTER TABLE "messages" ADD COLUMN "kind" TEXT;
