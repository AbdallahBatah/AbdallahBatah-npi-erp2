import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { NotificationsController } from './notifications.controller';

/** M2 cross-cutting platform features: attachments + in-app notifications. */
@Module({
  controllers: [AttachmentsController, NotificationsController],
  providers: [AttachmentsService],
})
export class PlatformModule {}
