import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PpaService } from './ppa.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import { CreatePpaTermDto, SettleDto } from './dto';

@Controller('ppa')
@UseGuards(PermissionsGuard)
export class PpaController {
  constructor(private readonly ppa: PpaService) {}

  @Get('terms')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  listTerms(@CurrentUser() user: AuthUser) {
    return this.ppa.listTerms(user);
  }

  @Post('terms')
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  createTerm(@CurrentUser() user: AuthUser, @Body() dto: CreatePpaTermDto) {
    return this.ppa.createTerm(user, dto);
  }

  /** PPA-03: settle a period into a SETTLEMENT invoice. */
  @Post('terms/:id/settle')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  settle(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SettleDto) {
    return this.ppa.settle(user, id, dto);
  }

  @Get('runs')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  listRuns(@CurrentUser() user: AuthUser) {
    return this.ppa.listRuns(user);
  }
}
