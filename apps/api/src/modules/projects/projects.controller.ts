import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import { AssignProjectDto, CreateChangeOrderDto, CreateProjectDto, PlanElementDto, SetStageDto } from './dto';

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

  /**
   * Package 4 · P4-1: the projects general manager names the engineer and the dates.
   * The contract write key, not the project one: the engineer's preset holds
   * projects.project.write, and an engineer must not assign themselves.
   */
  @Patch(':id/assignment')
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AssignProjectDto) {
    return this.projects.assign(user, id, dto);
  }

  /** Package 4 · P4-1 (work cycle step 10): the engineer plans a budget line. */
  @Patch(':id/wbs/:wbsId/plan')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  planElement(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('wbsId') wbsId: string,
    @Body() dto: PlanElementDto,
  ) {
    return this.projects.planElement(user, id, wbsId, dto);
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
