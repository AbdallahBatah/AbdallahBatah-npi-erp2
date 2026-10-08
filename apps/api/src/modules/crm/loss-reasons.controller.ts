import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';
import { LossReasonsService } from './loss-reasons.service';
import { CreateLossReasonDto, UpdateLossReasonDto } from './dto';

/** No DELETE: a reason that was used is retired with isActive = false. */
@Controller('loss-reasons')
@UseGuards(PermissionsGuard)
export class LossReasonsController {
  constructor(private readonly reasons: LossReasonsService) {}

  /** `?all=1` adds the switched-off reasons — for administrators only (ignored otherwise). */
  @Get()
  @RequirePermissions(PERMISSIONS.OPPORTUNITY_READ)
  list(@CurrentUser() user: AuthUser, @Query('all') all?: string) {
    return this.reasons.list(user, all === '1' || all === 'true');
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLossReasonDto) {
    return this.reasons.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateLossReasonDto) {
    return this.reasons.update(user, id, dto);
  }
}
