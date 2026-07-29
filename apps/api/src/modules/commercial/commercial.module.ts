import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { ProposalsController } from './proposals.controller';
import { ProposalsService } from './proposals.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

@Module({
  controllers: [ItemsController, ProposalsController, ContractsController],
  providers: [ItemsService, ProposalsService, ContractsService],
})
export class CommercialModule {}
