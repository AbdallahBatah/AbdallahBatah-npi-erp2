DELETE FROM "ApprovalRuleStep" WHERE "ruleId" IN (SELECT "id" FROM "ApprovalRule" WHERE "documentType" = 'EXECUTION_OVERRUN');
DELETE FROM "ApprovalRule" WHERE "documentType" = 'EXECUTION_OVERRUN';
