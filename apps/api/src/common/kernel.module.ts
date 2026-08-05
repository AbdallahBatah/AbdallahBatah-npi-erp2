import { Global, Module } from '@nestjs/common';
import { NumberingService } from './numbering.service';
import { AuditService } from './audit.service';
import { PostingService } from './posting.service';
import { TaxService } from './tax.service';
import { NotificationService } from './notification.service';
import { ApprovalService } from './approval.service';

/**
 * Shared kernel services (numbering, audit, posting rules, tax, approvals)
 * available to every business module without re-importing — this is the
 * in-process "shared kernel" from the spec. The approval matrix lives here
 * rather than in a feature module so procurement, projects and finance can all
 * gate on it without any of them depending on each other.
 */
@Global()
@Module({
  providers: [
    NumberingService,
    AuditService,
    PostingService,
    TaxService,
    NotificationService,
    ApprovalService,
  ],
  exports: [
    NumberingService,
    AuditService,
    PostingService,
    TaxService,
    NotificationService,
    ApprovalService,
  ],
})
export class KernelModule {}
