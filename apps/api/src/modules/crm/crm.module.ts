import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CustomerContactsService } from './customer-contacts.service';
import { CustomerMergeService } from './customer-merge.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';
import { LossReasonsController } from './loss-reasons.controller';
import { LossReasonsService } from './loss-reasons.service';

@Module({
  controllers: [CustomersController, LeadsController, OpportunitiesController, LossReasonsController],
  providers: [
    CustomersService,
    CustomerContactsService,
    CustomerMergeService,
    LeadsService,
    OpportunitiesService,
    LossReasonsService,
  ],
  exports: [OpportunitiesService],
})
export class CrmModule {}
