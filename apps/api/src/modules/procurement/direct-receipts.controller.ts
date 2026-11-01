import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { CreateDirectReceiptDto, DirectReceiptsService } from './direct-receipts.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

/** P4-7 — the keeper (procurement write) books it; procurement readers see it. */
@Controller('procurement/direct-receipts')
@UseGuards(PermissionsGuard)
export class DirectReceiptsController {
  constructor(private readonly receipts: DirectReceiptsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  list(@CurrentUser() user: AuthUser) {
    return this.receipts.list(user);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDirectReceiptDto) {
    return this.receipts.create(user, dto);
  }
}
