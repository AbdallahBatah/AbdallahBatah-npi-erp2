import { Global, Module } from '@nestjs/common';
import { NumberingService } from './numbering.service';
import { AuditService } from './audit.service';

/**
 * Shared kernel services (numbering, audit) available to every business module
 * without re-importing — this is the in-process "shared kernel" from the spec.
 */
@Global()
@Module({
  providers: [NumberingService, AuditService],
  exports: [NumberingService, AuditService],
})
export class KernelModule {}
