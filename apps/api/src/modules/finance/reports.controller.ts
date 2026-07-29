import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('finance/reports')
@UseGuards(PermissionsGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** FIN-05: IFRS-15 percentage-of-completion per contract. */
  @Get('poc')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  poc(@CurrentUser() user: AuthUser) {
    return this.reports.poc(user);
  }

  /** FIN-05: post the incremental recognition adjustment journal. */
  @Post('poc/:contractId/recognize')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  recognize(@CurrentUser() user: AuthUser, @Param('contractId') contractId: string) {
    return this.reports.recognize(user, contractId);
  }

  /** FIN-03: box-style VAT return for a period (defaults to current quarter). */
  @Get('vat-return')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  vatReturn(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.vatReturn(user, from, to);
  }

  /** FIN-07: estimate-vs-billed contract profitability. */
  @Get('profitability')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  profitability(@CurrentUser() user: AuthUser) {
    return this.reports.profitability(user);
  }

  /** FIN-01: trial balance — opening, period movement and closing per account. */
  @Get('trial-balance')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  trialBalance(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.trialBalance(user, from, to);
  }

  /** FIN-01: general ledger for one account, with a running balance. */
  @Get('general-ledger/:accountId')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  generalLedger(
    @CurrentUser() user: AuthUser,
    @Param('accountId') accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.reports.generalLedger(user, accountId, from, to, take, skip);
  }
}
