import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CustomerContactsService } from './customer-contacts.service';
import { CustomerMergeService } from './customer-merge.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';

@Module({
  controllers: [CustomersController, LeadsController, OpportunitiesController],
  providers: [
    CustomersService,
    CustomerContactsService,
    CustomerMergeService,
    LeadsService,
    OpportunitiesService,
  ],
  exports: [OpportunitiesService],
})
export class CrmModule {}
