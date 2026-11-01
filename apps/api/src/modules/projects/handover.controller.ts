import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { HandoverService } from './handover.service';
import { SaveHandoverDto } from './handover.dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

/** Package 7 (ADR-07) — handover, closure on approval, warranty register. */
@Controller('projects')
@UseGuards(PermissionsGuard)
export class HandoverController {
  constructor(private readonly handovers: HandoverService) {}

  @Get('warranties')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  warranties(@CurrentUser() user: AuthUser) {
    return this.handovers.warranties(user);
  }

  @Get('handovers/:handoverId')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  ref(@CurrentUser() user: AuthUser, @Param('handoverId') handoverId: string) {
    return this.handovers.ref(user, handoverId);
  }

  @Get(':id/handover')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.handovers.get(user, id);
  }

  @Put(':id/handover')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  save(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SaveHandoverDto) {
    return this.handovers.save(user, id, dto);
  }

  @Post(':id/handover/submit')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  submit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.handovers.submit(user, id);
  }
}
