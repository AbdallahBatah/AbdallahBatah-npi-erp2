import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RequisitionsService } from './requisitions.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import {
  ConvertToPoDto,
  CreateRequisitionDto,
  UpdateRequisitionDto,
  WorkflowActionDto,
} from './requisitions.dto';

/**
 * The requisition's HTTP surface. Note what is missing: there is no
 * `/approve`, no `/reject`, no `/return`. There is one `/actions` route, and
 * the engine decides from `wf_transitions` whether the named action is legal
 * for this document in this state for this caller.
 *
 * That is the point of the workflow table. A flow gaining a new transition
 * becomes reachable by configuration; it does not need a controller method,
 * a DTO and a deploy.
 */
@Controller('requisitions')
@UseGuards(PermissionsGuard)
export class RequisitionsController {
  constructor(private readonly requisitions: RequisitionsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.requisitions.list(user, {
      status,
      take: Math.min(Number(take) || 50, 200),
      skip: Number(skip) || 0,
    });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requisitions.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRequisitionDto) {
    return this.requisitions.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateRequisitionDto,
  ) {
    return this.requisitions.update(user, id, dto);
  }

  /**
   * Declares only the *baseline* permission — anyone who may raise a
   * requisition may ask for an action on one. Whether this particular action
   * is allowed is the engine's call, against the transition's own
   * `requiredPermission`, which is stricter and state-dependent in a way a
   * route decorator cannot express.
   */
  @Post(':id/actions')
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  act(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: WorkflowActionDto,
  ) {
    return this.requisitions.act(user, id, dto.action, dto.comment);
  }

  /** Choosing a vendor and committing the company: procurement's own authority. */
  @Post(':id/convert')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  convert(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConvertToPoDto,
  ) {
    return this.requisitions.convertToPo(user, id, dto);
  }
}
