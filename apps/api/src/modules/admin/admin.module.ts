import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/** User & role administration (the tenant's own self-service — not superadmin). */
@Module({
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
