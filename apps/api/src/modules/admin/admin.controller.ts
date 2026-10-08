import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { OrgSettingsService } from '../../common/org-settings.service';
import { CreateRoleDto, CreateUserDto, ResetPasswordDto, UpdateOrgDto, UpdateRoleDto, UpdateUserDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS, PERMISSION_CATALOG } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('admin')
@UseGuards(PermissionsGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly settings: OrgSettingsService,
  ) {}

  /** Bilingual catalog for the role editor — one source of truth in @npi/shared. */
  @Get('permissions')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  permissionCatalog() {
    return PERMISSION_CATALOG;
  }

  @Get('users')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  listUsers(@CurrentUser() user: AuthUser) {
    return this.admin.listUsers(user);
  }

  @Post('users')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  createUser(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.admin.createUser(user, dto);
  }

  @Patch('users/:id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  updateUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.admin.updateUser(user, id, dto);
  }

  @Post('users/:id/reset-password')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.admin.resetPassword(user, id, dto);
  }

  @Get('roles')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  listRoles(@CurrentUser() user: AuthUser) {
    return this.admin.listRoles(user);
  }

  @Post('roles')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  createRole(@CurrentUser() user: AuthUser, @Body() dto: CreateRoleDto) {
    return this.admin.createRole(user, dto);
  }

  @Patch('roles/:id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  updateRole(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.admin.updateRole(user, id, dto);
  }

  @Delete('roles/:id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  deleteRole(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.deleteRole(user, id);
  }

  /**
   * Read side of the append-only audit trail (UAT 2026-08-01 control-gap
   * recommendation). `audit/facets` MUST stay declared before any dynamic
   * segment ever added under `audit/` — Nest matches in declaration order.
   */
  @Get('audit')
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  listAudit(
    @CurrentUser() user: AuthUser,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.listAudit(user, {
      entityType,
      entityId,
      action,
      actorId,
      from,
      to,
      take: Math.min(Number(take) || 50, 200),
      skip: Number(skip) || 0,
    });
  }

  @Get('audit/facets')
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  auditFacets(@CurrentUser() user: AuthUser) {
    return this.admin.auditFacets(user);
  }

  @Get('org')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  getOrg(@CurrentUser() user: AuthUser) {
    return this.admin.getOrg(user);
  }

  @Patch('org')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  updateOrg(@CurrentUser() user: AuthUser, @Body() dto: UpdateOrgDto) {
    return this.admin.updateOrg(user, dto);
  }

  /**
   * CRM Phase 1 · Step 4: the few organization settings that are safe to edit from
   * the screen (proposal validity, cost-age warning, name-similarity threshold) as a
   * flat { key: value } object. Any other key is a 400; so is a value out of range.
   */
  @Get('settings')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  getSettings(@CurrentUser() user: AuthUser) {
    return this.settings.getEditable(user.organizationId);
  }

  @Patch('settings')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  async updateSettings(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    await this.settings.setEditable(user.organizationId, body ?? {}, user.userId);
    return this.settings.getEditable(user.organizationId);
  }
}
