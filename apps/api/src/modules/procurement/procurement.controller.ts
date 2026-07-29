import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ProcurementService } from './procurement.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import {
  CreateBillDto,
  CreateClaimDto,
  CreatePoDto,
  CreateSubcontractDto,
  CreateVendorDto,
  ReceiveDto,
  TransferDto,
} from './dto';

@Controller('procurement')
@UseGuards(PermissionsGuard)
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  // ── Vendors ──────────────────────────────────────────────────────────────
  @Get('vendors')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  listVendors(@CurrentUser() user: AuthUser) {
    return this.procurement.listVendors(user);
  }

  @Post('vendors')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  createVendor(@CurrentUser() user: AuthUser, @Body() dto: CreateVendorDto) {
    return this.procurement.createVendor(user, dto);
  }

  // ── Purchase orders ──────────────────────────────────────────────────────
  @Get('purchase-orders')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  listPos(@CurrentUser() user: AuthUser) {
    return this.procurement.listPos(user);
  }

  @Get('purchase-orders/:id')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  getPo(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.procurement.getPo(user, id);
  }

  @Post('purchase-orders')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  createPo(@CurrentUser() user: AuthUser, @Body() dto: CreatePoDto) {
    return this.procurement.createPo(user, dto);
  }

  @Post('purchase-orders/:id/approve')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  approvePo(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.procurement.approvePo(user, id);
  }

  @Post('purchase-orders/:id/receive')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  receive(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReceiveDto) {
    return this.procurement.receive(user, id, dto);
  }

  // ── Vendor bills ─────────────────────────────────────────────────────────
  @Post('bills')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  createBill(@CurrentUser() user: AuthUser, @Body() dto: CreateBillDto) {
    return this.procurement.createBill(user, dto);
  }

  // ── Subcontracts & claims (PRJ-07) ───────────────────────────────────────
  @Get('subcontracts')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  listSubcontracts(@CurrentUser() user: AuthUser) {
    return this.procurement.listSubcontracts(user);
  }

  @Post('subcontracts')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  createSubcontract(@CurrentUser() user: AuthUser, @Body() dto: CreateSubcontractDto) {
    return this.procurement.createSubcontract(user, dto);
  }

  @Post('subcontracts/:id/claims')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  createClaim(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateClaimDto) {
    return this.procurement.createClaim(user, id, dto);
  }

  @Post('claims/:id/approve')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  approveClaim(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.procurement.approveClaim(user, id);
  }

  // ── Locations, stock & transfers (SCM-04) ────────────────────────────────
  @Get('locations')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  listLocations(@CurrentUser() user: AuthUser) {
    return this.procurement.listLocations(user);
  }

  @Get('stock')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  listStock(@CurrentUser() user: AuthUser) {
    return this.procurement.listStock(user);
  }

  @Post('transfers')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  transfer(@CurrentUser() user: AuthUser, @Body() dto: TransferDto) {
    return this.procurement.transfer(user, dto);
  }

  // ── Serial units (asset registry seed) ───────────────────────────────────
  @Get('serial-units')
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  listSerialUnits(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('state') state?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.procurement.listSerialUnits(user, {
      search,
      state,
      take: take !== undefined ? Math.min(Number(take) || 50, 500) : undefined,
      skip: skip !== undefined ? Number(skip) || 0 : undefined,
    });
  }

  @Post('serial-units/:id/install')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  install(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.procurement.installSerialUnit(user, id);
  }
}
