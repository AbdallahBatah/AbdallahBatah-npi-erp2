import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';

@Module({
  controllers: [CustomersController, LeadsController, OpportunitiesController],
  providers: [CustomersService, LeadsService, OpportunitiesService],
  exports: [OpportunitiesService],
})
export class CrmModule {}
