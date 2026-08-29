import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto, SetDepartmentMembersDto, UpdateDepartmentDto } from './structure.dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

/**
 * Departments. Every route carries admin.department.manage and every query is
 * scoped by the organizationId on the JWT — the client never names the tenant.
 *
 * `directory` is declared before `:id` — Nest matches in declaration order, so
 * a static segment added later under a dynamic one would be unreachable.
 */
@Controller('admin/departments')
@UseGuards(PermissionsGuard)
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.DEPARTMENT_MANAGE)
  list(@CurrentUser() user: AuthUser) {
    return this.departments.list(user);
  }

  /** People picker — the department screen cannot assume admin.user.manage. */
  @Get('directory')
  @RequirePermissions(PERMISSIONS.DEPARTMENT_MANAGE)
  directory(@CurrentUser() user: AuthUser) {
    return this.departments.directory(user);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.DEPARTMENT_MANAGE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDepartmentDto) {
    return this.departments.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.DEPARTMENT_MANAGE)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.departments.update(user, id, dto);
  }

  /** PUT, not POST: the body is the whole membership, not an addition to it. */
  @Put(':id/members')
  @RequirePermissions(PERMISSIONS.DEPARTMENT_MANAGE)
  setMembers(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetDepartmentMembersDto,
  ) {
    return this.departments.setMembers(user, id, dto);
  }
}
