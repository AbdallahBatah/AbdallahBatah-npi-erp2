import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PayablesService } from './payables.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import { PayVendorDto } from './dto';
import type { AuthUser } from '../../common/auth-user';

@Controller('finance/payables')
@UseGuards(PermissionsGuard)
export class PayablesController {
  constructor(private readonly payables: PayablesService) {}

  /** Everything still owed to vendors — bills and approved claims. */
  @Get('outstanding')
  @RequirePermissions(PERMISSIONS.PAYMENT_READ)
  outstanding(@CurrentUser() user: AuthUser, @Query('vendorId') vendorId?: string) {
    return this.payables.outstanding(user, vendorId);
  }

  @Get('payments')
  @RequirePermissions(PERMISSIONS.PAYMENT_READ)
  listPayments(@CurrentUser() user: AuthUser, @Query('vendorId') vendorId?: string) {
    return this.payables.listPayments(user, vendorId);
  }

  /** Pay a vendor: Dr AP / Cr Bank, allocated over its open documents. */
  @Post('payments')
  @RequirePermissions(PERMISSIONS.PAYMENT_WRITE)
  pay(@CurrentUser() user: AuthUser, @Body() dto: PayVendorDto) {
    return this.payables.pay(user, dto);
  }

  /** Move a subcontractor's withheld retention into payables. */
  @Post('claims/:id/release-retention')
  @RequirePermissions(PERMISSIONS.PAYMENT_WRITE)
  releaseRetention(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payables.releaseClaimRetention(user, id);
  }
}
