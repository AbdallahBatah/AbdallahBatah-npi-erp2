import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApprovalRulesService } from './approvals.service';
import { ApprovalService } from '../../common/approval.service';
import { CreateApprovalRuleDto, DecideDto, UpdateApprovalRuleDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions, SkipPermissions } from '../../common/decorators';
import { APPROVAL_DOCUMENTS, PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

/**
 * Two audiences, one resource. Configuring the matrix is an administrator's
 * job and carries its own permission; acting on a request is the ordinary
 * business permission for that document — which is why the decide route is
 * @SkipPermissions and checks inside, where the document type is known.
 *
 * Static segments are declared before `:id` — Nest matches in declaration
 * order, so `rules` must never be reachable as an id.
 */
@Controller('approvals')
@UseGuards(PermissionsGuard)
export class ApprovalsController {
  constructor(
    private readonly rules: ApprovalRulesService,
    private readonly approvals: ApprovalService,
  ) {}

  /** The document types the matrix actually covers, with their labels. */
  @Get('documents')
  @RequirePermissions(PERMISSIONS.APPROVAL_MANAGE)
  documents() {
    return APPROVAL_DOCUMENTS;
  }

  @Get('rules')
  @RequirePermissions(PERMISSIONS.APPROVAL_MANAGE)
  listRules(@CurrentUser() user: AuthUser) {
    return this.rules.list(user);
  }

  @Post('rules')
  @RequirePermissions(PERMISSIONS.APPROVAL_MANAGE)
  createRule(@CurrentUser() user: AuthUser, @Body() dto: CreateApprovalRuleDto) {
    return this.rules.create(user, dto);
  }

  @Patch('rules/:id')
  @RequirePermissions(PERMISSIONS.APPROVAL_MANAGE)
  updateRule(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateApprovalRuleDto,
  ) {
    return this.rules.update(user, id, dto);
  }

  @Delete('rules/:id')
  @RequirePermissions(PERMISSIONS.APPROVAL_MANAGE)
  deleteRule(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.rules.remove(user, id);
  }

  /**
   * What is waiting on *my* role. @SkipPermissions like /notifications: the
   * query is hard-scoped to the caller's own role, and the decision itself is
   * where authority is checked.
   */
  @Get('inbox')
  @SkipPermissions()
  inbox(@CurrentUser() user: AuthUser) {
    return this.approvals.inbox(user);
  }

  @Get('inbox/count')
  @SkipPermissions()
  async inboxCount(@CurrentUser() user: AuthUser) {
    return { count: await this.approvals.inboxCount(user) };
  }

  /** The control view: every chain this organization has ever opened. */
  @Get('history')
  @RequirePermissions(PERMISSIONS.APPROVAL_MANAGE)
  history(
    @CurrentUser() user: AuthUser,
    @Query('documentType') documentType?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.approvals.history(user, {
      documentType,
      status,
      take: Math.min(Number(take) || 50, 200),
      skip: Number(skip) || 0,
    });
  }

  @Post(':id/decide')
  @SkipPermissions()
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DecideDto,
  ) {
    return this.approvals.decide(user, id, dto.decision, dto.note);
  }
}
