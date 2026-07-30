import { Global, Module } from '@nestjs/common';
import { NumberingService } from './numbering.service';
import { AuditService } from './audit.service';
import { PostingService } from './posting.service';
import { TaxService } from './tax.service';
import { NotificationService } from './notification.service';

/**
 * Shared kernel services (numbering, audit, posting rules, tax) available to
 * every business module without re-importing — this is the in-process "shared
 * kernel" from the spec.
 */
@Global()
@Module({
  providers: [NumberingService, AuditService, PostingService, TaxService, NotificationService],
  exports: [NumberingService, AuditService, PostingService, TaxService, NotificationService],
})
export class KernelModule {}
