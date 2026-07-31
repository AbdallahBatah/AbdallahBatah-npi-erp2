import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { CreateRoleDto, CreateUserDto, ResetPasswordDto, UpdateOrgDto, UpdateRoleDto, UpdateUserDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS, PERMISSION_CATALOG } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('admin')
@UseGuards(PermissionsGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

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
}
