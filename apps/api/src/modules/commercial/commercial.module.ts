import { Module } from '@nestjs/common';
import { CrmModule } from '../crm/crm.module';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { ProposalsController } from './proposals.controller';
import { ProposalsService } from './proposals.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ItemCostService } from './item-cost.service';
import { ProposalExpiryScheduler } from './proposal-expiry.scheduler';

@Module({
  // Proposals and contracts move the opportunity through its stage rules.
  imports: [CrmModule],
  controllers: [ItemsController, ProposalsController, ContractsController],
  providers: [ItemsService, ProposalsService, ContractsService, ItemCostService, ProposalExpiryScheduler],
})
export class CommercialModule {}
