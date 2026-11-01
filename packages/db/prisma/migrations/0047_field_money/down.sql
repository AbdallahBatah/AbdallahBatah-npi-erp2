DROP TABLE IF EXISTS "PettyCashLine";
DROP TABLE IF EXISTS "PettyCashMovement";
DROP TABLE IF EXISTS "PettyCashCustody";
DROP TABLE IF EXISTS "VendorPaymentRequest";
DROP TYPE IF EXISTS "PettyCashMovementStatus";
DROP TYPE IF EXISTS "PettyCashMovementKind";
DROP TYPE IF EXISTS "CustodyStatus";
DROP TYPE IF EXISTS "PaymentRequestStatus";
DROP TYPE IF EXISTS "VendorPaymentKind";
-- The new ApprovalDocument / PostingPurpose values stay (Postgres cannot drop enum values); 0048 down removes their rows.
