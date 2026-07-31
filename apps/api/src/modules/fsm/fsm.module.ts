import { Module } from '@nestjs/common';
import { FsmController } from './fsm.controller';
import { FsmService } from './fsm.service';
import { FsmScheduler } from './fsm.scheduler';

@Module({
  controllers: [FsmController],
  providers: [FsmService, FsmScheduler],
})
export class FsmModule {}
