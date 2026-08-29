import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { InboxService } from './inbox.service';
import { OutboxService } from '../../common/workflow/outbox.service';
import { EventDispatcher } from '../../common/workflow/event-dispatcher.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions, SkipPermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import { WorkflowActionDto } from '../procurement/requisitions.dto';

@Controller('inbox')
@UseGuards(PermissionsGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: EventDispatcher,
  ) {}

  /**
   * @SkipPermissions like /notifications and the approvals inbox: the query is
   * hard-scoped to the caller's own role, and every listed task is acted on
   * through a route that checks authority for that specific action.
   */
  @Get('tasks')
  @SkipPermissions()
  tasks(@CurrentUser() user: AuthUser) {
    return this.inbox.tasks(user);
  }

  @Get('count')
  @SkipPermissions()
  count(@CurrentUser() user: AuthUser) {
    return this.inbox.count(user);
  }

  /** The organization-wide view — a control, so it carries a control's key. */
  @Get('monitor')
  @RequirePermissions(PERMISSIONS.WORKFLOW_MANAGE)
  monitor(@CurrentUser() user: AuthUser) {
    return this.inbox.monitor(user);
  }

  /** What consequences failed to happen, and why. */
  @Get('events/failed')
  @RequirePermissions(PERMISSIONS.WORKFLOW_MANAGE)
  failedEvents(@CurrentUser() user: AuthUser) {
    return this.outbox.failed(user.organizationId);
  }

  /**
   * Re-run a failed consequence. Deliberately manual and permissioned: the
   * event failed for a reason, and replaying it before that reason is fixed
   * just burns the retry budget again.
   */
  @Post('events/:id/requeue')
  @RequirePermissions(PERMISSIONS.WORKFLOW_MANAGE)
  async requeue(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() _dto: WorkflowActionDto,
  ) {
    const ok = await this.outbox.requeue(user.organizationId, id);
    return { requeued: ok };
  }

  /** Drain now rather than waiting for the next tick — for tests and support. */
  @Post('events/drain')
  @RequirePermissions(PERMISSIONS.WORKFLOW_MANAGE)
  drain() {
    return this.dispatcher.drain();
  }
}
