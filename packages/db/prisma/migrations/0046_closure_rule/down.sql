DELETE FROM "ApprovalRuleStep" WHERE "ruleId" IN (SELECT "id" FROM "ApprovalRule" WHERE "documentType" = 'PROJECT_CLOSURE');
DELETE FROM "ApprovalRule" WHERE "documentType" = 'PROJECT_CLOSURE';
