import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { PaymentRequestsService } from './payment-requests.service';
import { PettyCashService } from './petty-cash.service';
import {
  CashAmountDto,
  CreateCustodyDto,
  CreatePaymentRequestDto,
  CreateSettlementDto,
  PayRequestDto,
} from './field-money.dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

/**
 * Package 6 · P6-1 (ADR-06) — طلب صرف دفعة للموردين. Raised on the requisition
 * key (the engineer's), paid on the payment key (the accountant's); reading is
 * either, or the signer's key. The service narrows the engineer to his own.
 */
@Controller('payment-requests')
@UseGuards(PermissionsGuard)
export class PaymentRequestsController {
  constructor(private readonly requests: PaymentRequestsService) {}

  @Get()
  @RequireAnyPermission(PERMISSIONS.REQUISITION_READ, PERMISSIONS.PAYMENT_READ, PERMISSIONS.PROCUREMENT_APPROVE)
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.requests.list(user, status);
  }

  @Get(':id')
  @RequireAnyPermission(PERMISSIONS.REQUISITION_READ, PERMISSIONS.PAYMENT_READ, PERMISSIONS.PROCUREMENT_APPROVE)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentRequestDto) {
    return this.requests.create(user, dto);
  }

  @Post(':id/pay')
  @RequirePermissions(PERMISSIONS.PAYMENT_WRITE)
  pay(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PayRequestDto) {
    return this.requests.pay(user, id, dto);
  }
}

/**
 * Package 6 · P6-2 — العُهدة. The accountant opens, funds, takes back and
 * closes; the custodian settles (the service checks it is him).
 */
@Controller('petty-cash')
@UseGuards(PermissionsGuard)
export class PettyCashController {
  constructor(private readonly cash: PettyCashService) {}

  @Get()
  @RequireAnyPermission(PERMISSIONS.PROJECT_READ, PERMISSIONS.PAYMENT_READ)
  list(@CurrentUser() user: AuthUser) {
    return this.cash.list(user);
  }

  @Get('movements/:movementId')
  @RequireAnyPermission(PERMISSIONS.PROJECT_READ, PERMISSIONS.PAYMENT_READ)
  movement(@CurrentUser() user: AuthUser, @Param('movementId') movementId: string) {
    return this.cash.movementRef(user, movementId);
  }

  @Get(':id')
  @RequireAnyPermission(PERMISSIONS.PROJECT_READ, PERMISSIONS.PAYMENT_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cash.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PAYMENT_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustodyDto) {
    return this.cash.create(user, dto);
  }

  @Post(':id/fund')
  @RequirePermissions(PERMISSIONS.PAYMENT_WRITE)
  fund(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CashAmountDto) {
    return this.cash.fund(user, id, dto);
  }

  @Post(':id/settle')
  @RequireAnyPermission(PERMISSIONS.PROJECT_READ, PERMISSIONS.PAYMENT_READ)
  settle(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateSettlementDto) {
    return this.cash.settle(user, id, dto);
  }

  @Post(':id/return')
  @RequirePermissions(PERMISSIONS.PAYMENT_WRITE)
  returnCash(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CashAmountDto) {
    return this.cash.returnCash(user, id, dto);
  }

  @Post(':id/close')
  @RequirePermissions(PERMISSIONS.PAYMENT_WRITE)
  close(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cash.close(user, id);
  }
}
