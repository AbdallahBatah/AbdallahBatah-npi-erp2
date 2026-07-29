import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { FsmService } from './fsm.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import {
  AddPartDto,
  AddTimeDto,
  AssignDto,
  CompleteDto,
  CreatePlanDto,
  CreateWarrantyClaimDto,
  CreateWorkOrderDto,
  ReplaceSerialDto,
} from './dto';

@Controller('fsm')
@UseGuards(PermissionsGuard)
export class FsmController {
  constructor(private readonly fsm: FsmService) {}

  // ── Assets & crew ────────────────────────────────────────────────────────
  @Get('assets')
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  listAssets(@CurrentUser() user: AuthUser) {
    return this.fsm.listAssets(user);
  }

  @Get('technicians')
  @RequirePermissions(PERMISSIONS.WORKORDER_READ)
  listTechnicians(@CurrentUser() user: AuthUser) {
    return this.fsm.listTechnicians(user);
  }

  // ── Work orders ──────────────────────────────────────────────────────────
  @Get('work-orders/summary')
  @RequirePermissions(PERMISSIONS.WORKORDER_READ)
  summary(@CurrentUser() user: AuthUser) {
    return this.fsm.summary(user);
  }

  @Get('work-orders')
  @RequirePermissions(PERMISSIONS.WORKORDER_READ)
  list(@CurrentUser() user: AuthUser) {
    return this.fsm.list(user);
  }

  @Get('work-orders/:id')
  @RequirePermissions(PERMISSIONS.WORKORDER_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fsm.get(user, id);
  }

  @Post('work-orders')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkOrderDto) {
    return this.fsm.create(user, dto);
  }

  @Post('work-orders/:id/assign')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AssignDto) {
    return this.fsm.assign(user, id, dto);
  }

  @Post('work-orders/:id/start')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  start(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fsm.start(user, id);
  }

  @Post('work-orders/:id/parts')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  addPart(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AddPartDto) {
    return this.fsm.addPart(user, id, dto);
  }

  @Post('work-orders/:id/complete')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  complete(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CompleteDto) {
    return this.fsm.complete(user, id, dto);
  }

  @Post('work-orders/:id/close')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  close(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fsm.close(user, id);
  }

  @Post('work-orders/:id/cancel')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fsm.cancel(user, id);
  }

  @Post('work-orders/:id/time')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  addTime(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AddTimeDto) {
    return this.fsm.addTime(user, id, dto);
  }

  // ── Warranty claims / RMA (FSM-09) ───────────────────────────────────────
  @Get('warranty-claims')
  @RequirePermissions(PERMISSIONS.WORKORDER_READ)
  listClaims(@CurrentUser() user: AuthUser) {
    return this.fsm.listClaims(user);
  }

  @Post('warranty-claims')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  createClaim(@CurrentUser() user: AuthUser, @Body() dto: CreateWarrantyClaimDto) {
    return this.fsm.createClaim(user, dto);
  }

  @Post('warranty-claims/:id/submit')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  submitClaim(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fsm.submitClaim(user, id);
  }

  @Post('warranty-claims/:id/approve')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  approveClaim(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fsm.approveClaim(user, id);
  }

  @Post('warranty-claims/:id/reject')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  rejectClaim(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.fsm.rejectClaim(user, id);
  }

  @Post('warranty-claims/:id/replace')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  replaceSerial(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReplaceSerialDto) {
    return this.fsm.replaceSerial(user, id, dto);
  }

  // ── Maintenance plans ────────────────────────────────────────────────────
  @Get('plans')
  @RequirePermissions(PERMISSIONS.WORKORDER_READ)
  listPlans(@CurrentUser() user: AuthUser) {
    return this.fsm.listPlans(user);
  }

  @Post('plans')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  createPlan(@CurrentUser() user: AuthUser, @Body() dto: CreatePlanDto) {
    return this.fsm.createPlan(user, dto);
  }

  @Post('plans/generate-due')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  generateDue(@CurrentUser() user: AuthUser) {
    return this.fsm.generateDue(user);
  }
}
