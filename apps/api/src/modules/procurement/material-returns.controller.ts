import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { MaterialReturnsService } from './material-returns.service';
import { CreateMaterialReturnDto, ReceiveMaterialReturnDto } from './material-returns.dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

/**
 * Package 5 · P5-4 — إذن مرتجع المواد. The engineer raises (requisition write,
 * which his preset holds); the keeper receives (procurement write).
 */
@Controller('material-returns')
@UseGuards(PermissionsGuard)
export class MaterialReturnsController {
  constructor(private readonly returns: MaterialReturnsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.REQUISITION_READ)
  list(@CurrentUser() user: AuthUser, @Query('projectId') projectId?: string, @Query('status') status?: string) {
    return this.returns.list(user, { projectId, status });
  }

  @Get('site-stock')
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  siteStock(@CurrentUser() user: AuthUser, @Query('projectId') projectId: string) {
    return this.returns.siteStock(user, projectId);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.REQUISITION_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.returns.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateMaterialReturnDto) {
    return this.returns.create(user, dto);
  }

  @Post(':id/receive')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  receive(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReceiveMaterialReturnDto) {
    return this.returns.receive(user, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.REQUISITION_READ)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.returns.cancel(user, id);
  }
}
