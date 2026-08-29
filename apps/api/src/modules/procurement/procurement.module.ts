import { Module } from '@nestjs/common';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { RequisitionsController } from './requisitions.controller';
import { RequisitionsService } from './requisitions.service';

/**
 * Procurement owns the whole purchasing cycle §7 describes, requisition
 * included: the requisition is the first document of the same flow, not a
 * separate domain, and splitting it into its own module would put a boundary
 * across the middle of one business process.
 */
@Module({
  controllers: [ProcurementController, RequisitionsController],
  providers: [ProcurementService, RequisitionsService],
})
export class ProcurementModule {}
