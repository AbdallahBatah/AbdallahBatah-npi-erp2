import { Module } from '@nestjs/common';
import { PpaController } from './ppa.controller';
import { PpaService } from './ppa.service';

@Module({
  controllers: [PpaController],
  providers: [PpaService],
})
export class PpaModule {}
