import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { DelegationsService } from './delegations.service';
import { CreateDelegationDto } from './structure.dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

/**
 * Temporary delegations. Configuring who may sign for whom is a
 * delegation-of-authority control, so it carries its own permission rather
 * than riding on admin.user.manage.
 *
 * There is no PATCH: a granted window is evidence. It is ended by revoking it,
 * which leaves the original dates readable, and a different window is a new
 * row.
 */
@Controller('admin/delegations')
@UseGuards(PermissionsGuard)
export class DelegationsController {
  constructor(private readonly delegations: DelegationsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.DELEGATION_MANAGE)
  list(@CurrentUser() user: AuthUser) {
    return this.delegations.list(user);
  }

  @Get('directory')
  @RequirePermissions(PERMISSIONS.DELEGATION_MANAGE)
  directory(@CurrentUser() user: AuthUser) {
    return this.delegations.directory(user);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.DELEGATION_MANAGE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDelegationDto) {
    return this.delegations.create(user, dto);
  }

  @Post(':id/revoke')
  @RequirePermissions(PERMISSIONS.DELEGATION_MANAGE)
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.delegations.revoke(user, id);
  }
}
