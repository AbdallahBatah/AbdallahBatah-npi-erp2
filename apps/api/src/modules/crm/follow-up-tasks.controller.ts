import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { FollowUpTasksService } from './follow-up-tasks.service';
import { CancelTaskDto, CreateTaskDto, UpdateTaskDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

/**
 * Follow-up tasks. Customer-read to see them, customer-write to create, edit, complete,
 * cancel or re-assign — and the tasks are the TEAM's: anyone with the write key acts on
 * any task of the organization (the audit trail names who). No new keys (CRM Step 5).
 */
@Controller('tasks')
@UseGuards(PermissionsGuard)
export class FollowUpTasksController {
  constructor(private readonly tasks: FollowUpTasksService) {}

  /**
   * `?mine=1|assigneeId=|customerId=|opportunityId=&status=OPEN|DONE|CANCELLED|ALL&due=overdue|today|week|all&take=`
   * Defaults: open tasks, any due date.
   */
  @Get()
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  list(
    @CurrentUser() user: AuthUser,
    @Query('mine') mine?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('customerId') customerId?: string,
    @Query('opportunityId') opportunityId?: string,
    @Query('status') status?: string,
    @Query('due') due?: string,
    @Query('take') take?: string,
  ) {
    return this.tasks.list(user, {
      mine: mine === '1' || mine === 'true',
      assigneeId: assigneeId || undefined,
      customerId: customerId || undefined,
      opportunityId: opportunityId || undefined,
      status: status || undefined,
      due: due || undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskDto) {
    return this.tasks.create(user, dto);
  }

  /** Open tasks only (409 otherwise). */
  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(user, id, dto);
  }

  @Post(':id/complete')
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  complete(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.complete(user, id);
  }

  /** The reason is mandatory. */
  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CancelTaskDto) {
    return this.tasks.cancel(user, id, dto.reason);
  }
}
