import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { FiscalService } from './fiscal.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import { OpenYearDto } from './dto';
import type { AuthUser } from '../../common/auth-user';

@Controller('finance/fiscal')
@UseGuards(PermissionsGuard)
export class FiscalController {
  constructor(private readonly fiscal: FiscalService) {}

  @Get('years')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  years(@CurrentUser() user: AuthUser) {
    return this.fiscal.listYears(user);
  }

  @Post('years')
  @RequirePermissions(PERMISSIONS.PERIOD_MANAGE)
  openYear(@CurrentUser() user: AuthUser, @Body() dto: OpenYearDto) {
    return this.fiscal.openYear(user, dto.year);
  }

  @Post('periods/:id/close')
  @RequirePermissions(PERMISSIONS.PERIOD_MANAGE)
  closePeriod(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fiscal.setPeriodStatus(user, id, 'CLOSED');
  }

  @Post('periods/:id/reopen')
  @RequirePermissions(PERMISSIONS.PERIOD_MANAGE)
  reopenPeriod(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fiscal.setPeriodStatus(user, id, 'OPEN');
  }

  @Post('years/:id/close')
  @RequirePermissions(PERMISSIONS.PERIOD_MANAGE)
  closeYear(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fiscal.closeYear(user, id);
  }

  @Post('years/:id/reopen')
  @RequirePermissions(PERMISSIONS.PERIOD_MANAGE)
  reopenYear(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fiscal.reopenYear(user, id);
  }
}
