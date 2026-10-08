import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { CreateActivityDto, UpdateActivityDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

/**
 * The communication log. Reading it needs the customer-read key and writing it the
 * customer-write key — there are no keys of its own (CRM Step 5, decision 2). There is
 * deliberately no DELETE route: an entry is evidence.
 */
@Controller('activities')
@UseGuards(PermissionsGuard)
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  /** `?customerId=` or `?opportunityId=` (one of them is required), newest first, `?take=&cursor=`. */
  @Get()
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  list(
    @CurrentUser() user: AuthUser,
    @Query('customerId') customerId?: string,
    @Query('opportunityId') opportunityId?: string,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.activities.list(user, {
      customerId: customerId || undefined,
      opportunityId: opportunityId || undefined,
      take: take ? Number(take) : undefined,
      cursor: cursor || undefined,
    });
  }

  /** An entry, optionally with a follow-up task created in the same transaction. */
  @Post()
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateActivityDto) {
    return this.activities.create(user, dto);
  }

  /** The author only (403 for anyone else). */
  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateActivityDto) {
    return this.activities.update(user, id, dto);
  }
}
