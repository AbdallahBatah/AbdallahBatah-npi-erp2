import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

/**
 * The unified task box. It owns no data of its own — it reads the approval
 * matrix and the workflow engine, both kernel services, and merges them. That
 * is deliberate: a task box that stored its own copy of "who owes what" would
 * be a second source of truth to keep in sync, and the first one to drift.
 */
@Module({
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
