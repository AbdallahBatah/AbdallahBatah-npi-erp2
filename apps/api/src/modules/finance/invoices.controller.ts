import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { AddPaymentDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('finance')
@UseGuards(PermissionsGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('invoices')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  list(@CurrentUser() user: AuthUser) {
    return this.invoices.list(user);
  }

  @Get('invoices/:id')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.invoices.get(user, id);
  }

  @Post('contracts/:contractId/milestones/:milestoneId/invoice')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  generate(
    @CurrentUser() user: AuthUser,
    @Param('contractId') contractId: string,
    @Param('milestoneId') milestoneId: string,
  ) {
    return this.invoices.generateFromMilestone(user, contractId, milestoneId);
  }

  @Post('invoices/:id/issue')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  issue(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.invoices.issue(user, id);
  }

  @Post('invoices/:id/payments')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  addPayment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddPaymentDto,
  ) {
    return this.invoices.addPayment(user, id, dto);
  }

  @Post('retention/:id/release')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  releaseRetention(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.invoices.releaseRetention(user, id);
  }

  @Get('journal')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  journal(@CurrentUser() user: AuthUser) {
    return this.invoices.journal(user);
  }

  @Get('retention')
  @RequirePermissions(PERMISSIONS.LEDGER_READ)
  retention(@CurrentUser() user: AuthUser) {
    return this.invoices.retention(user);
  }

  @Get('summary')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  summary(@CurrentUser() user: AuthUser) {
    return this.invoices.summary(user);
  }
}
