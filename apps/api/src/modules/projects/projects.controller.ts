import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import { CreateChangeOrderDto, CreateProjectDto, SetStageDto } from './dto';

@Controller('projects')
@UseGuards(PermissionsGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  list(@CurrentUser() user: AuthUser) {
    return this.projects.list(user);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.createFromContract(user, dto);
  }

  @Post(':id/stage')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  setStage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetStageDto) {
    return this.projects.setStage(user, id, dto);
  }

  @Post(':id/change-orders')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  createChangeOrder(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateChangeOrderDto,
  ) {
    return this.projects.createChangeOrder(user, id, dto);
  }

  @Post('change-orders/:coId/approve')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  approveChangeOrder(@CurrentUser() user: AuthUser, @Param('coId') coId: string) {
    return this.projects.approveChangeOrder(user, coId);
  }
}
