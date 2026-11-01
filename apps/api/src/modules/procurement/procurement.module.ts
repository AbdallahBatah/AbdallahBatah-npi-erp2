import { Module } from '@nestjs/common';
import { ProcurementController } from './procurement.controller';
import { ProcurementService } from './procurement.service';
import { RequisitionsController } from './requisitions.controller';
import { RequisitionsService } from './requisitions.service';
import { MaterialRequestsController } from './material-requests.controller';
import { MaterialRequestsService } from './material-requests.service';
import { MaterialReturnsController } from './material-returns.controller';
import { MaterialReturnsService } from './material-returns.service';

/**
 * Procurement owns the whole purchasing cycle §7 describes, requisition
 * included: the requisition is the first document of the same flow, not a
 * separate domain, and splitting it into its own module would put a boundary
 * across the middle of one business process.
 */
@Module({
  controllers: [ProcurementController, RequisitionsController, MaterialRequestsController, MaterialReturnsController],
  providers: [ProcurementService, RequisitionsService, MaterialRequestsService, MaterialReturnsService],
})
export class ProcurementModule {}
