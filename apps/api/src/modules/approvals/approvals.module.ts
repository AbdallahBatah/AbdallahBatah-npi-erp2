import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalRulesService } from './approvals.service';

/**
 * Only the HTTP surface lives here. The matrix itself is a kernel service
 * (common/approval.service.ts) because procurement and projects gate on it —
 * putting it in a feature module would make them depend on this one.
 */
@Module({
  controllers: [ApprovalsController],
  providers: [ApprovalRulesService],
})
export class ApprovalsModule {}
