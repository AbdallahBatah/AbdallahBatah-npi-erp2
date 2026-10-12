import { Module } from '@nestjs/common';
import { ReferenceController } from './reference.controller';
import { ReferenceLookupsService } from './reference-lookups.service';

@Module({
  controllers: [ReferenceController],
  providers: [ReferenceLookupsService],
})
export class ReferenceModule {}
