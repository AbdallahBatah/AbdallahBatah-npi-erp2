import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { MaterialRequestsService } from './material-requests.service';
import {
  CreateMaterialIssueDto,
  CreateMaterialRequestDto,
  RaiseShortageDto,
  RejectMaterialRequestDto,
  UpdateMaterialRequestDto,
} from './material-requests.dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

/**
 * Package 4 · P4-2 / P4-3 — طلب المواد وإذن الصرف (ADR-04 §4-2, §4-3).
 * Read on the requisitions screen's key; each action on the key of whoever
 * performs it in the company's cycle (no new keys).
 */
@Controller('material-requests')
@UseGuards(PermissionsGuard)
export class MaterialRequestsController {
  constructor(private readonly requests: MaterialRequestsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.REQUISITION_READ)
  list(@CurrentUser() user: AuthUser, @Query('projectId') projectId?: string, @Query('status') status?: string) {
    return this.requests.list(user, { projectId, status });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.REQUISITION_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.get(user, id);
  }

  /** The site engineer. */
  @Post()
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateMaterialRequestDto) {
    return this.requests.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateMaterialRequestDto) {
    return this.requests.update(user, id, dto);
  }

  @Post(':id/submit')
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  submit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.submit(user, id);
  }

  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.cancel(user, id);
  }

  /** The projects general manager. */
  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_APPROVE)
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.approve(user, id);
  }

  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_APPROVE)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectMaterialRequestDto) {
    return this.requests.reject(user, id, dto);
  }

  /** The warehouse keeper: what one store can send for each line still owed. */
  @Get(':id/stock')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  stockFor(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('fromLocationId') fromLocationId: string) {
    return this.requests.stockFor(user, id, fromLocationId);
  }

  /** The warehouse keeper: an issue voucher to the project site. */
  @Post(':id/issues')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  issue(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateMaterialIssueDto) {
    return this.requests.issue(user, id, dto);
  }

  /** The warehouse keeper: a requisition for what is not in stock. */
  @Post(':id/requisition')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  raiseShortage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RaiseShortageDto) {
    return this.requests.raiseShortage(user, id, dto);
  }

  @Post('issues/:issueId/cancel')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  cancelIssue(@CurrentUser() user: AuthUser, @Param('issueId') issueId: string) {
    return this.requests.cancelIssue(user, issueId);
  }

  /** The engineer confirms the materials reached the site; stock moves here. */
  @Post('issues/:issueId/receive')
  @RequirePermissions(PERMISSIONS.REQUISITION_WRITE)
  confirmReceipt(@CurrentUser() user: AuthUser, @Param('issueId') issueId: string) {
    return this.requests.confirmReceipt(user, issueId);
  }
}
