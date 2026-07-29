import { Module } from '@nestjs/common';
import { FsmController } from './fsm.controller';
import { FsmService } from './fsm.service';

@Module({
  controllers: [FsmController],
  providers: [FsmService],
})
export class FsmModule {}
