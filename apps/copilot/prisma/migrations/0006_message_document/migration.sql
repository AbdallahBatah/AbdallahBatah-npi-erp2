-- The document attached to a chat message, so a reload can re-offer the flow
-- chips for an attached document (T-26). Plain id, no foreign key.
ALTER TABLE "messages" ADD COLUMN "documentId" TEXT;
