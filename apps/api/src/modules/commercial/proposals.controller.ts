import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProposalsService } from './proposals.service';
import { CreateProposalDto, CreateRevisionDto, RejectProposalDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('proposals')
@UseGuards(PermissionsGuard)
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PROPOSAL_READ)
  list(@CurrentUser() user: AuthUser) {
    return this.proposals.list(user);
  }

  /**
   * The cost a new line would get, per item (cost, source, age, stale flag).
   * Declared before `:id` — Nest matches in declaration order, so `cost-lookup`
   * must never be reachable as an id. Cost figures: costs.view is checked in the service.
   */
  @Get('cost-lookup')
  @RequirePermissions(PERMISSIONS.PROPOSAL_WRITE)
  costLookup(
    @CurrentUser() user: AuthUser,
    @Query('itemIds') itemIds?: string,
    @Query('currency') currency?: string,
  ) {
    const ids = (itemIds ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200);
    return this.proposals.costLookup(user, { itemIds: ids, currency });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PROPOSAL_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.proposals.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PROPOSAL_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProposalDto) {
    return this.proposals.create(user, dto);
  }

  @Post(':id/revisions')
  @RequirePermissions(PERMISSIONS.PROPOSAL_WRITE)
  addRevision(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateRevisionDto,
  ) {
    return this.proposals.addRevision(user, id, dto);
  }

  @Patch(':id/revisions/:revisionId')
  @RequirePermissions(PERMISSIONS.PROPOSAL_WRITE)
  updateRevision(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body() dto: CreateRevisionDto,
  ) {
    return this.proposals.updateRevision(user, id, revisionId, dto);
  }

  /** Raise the current draft for approval (the matrix decides who signs). */
  @Post(':id/submit')
  @RequirePermissions(PERMISSIONS.PROPOSAL_WRITE)
  submit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.proposals.submit(user, id);
  }

  /** Send the approved revision to the customer. */
  @Post(':id/send')
  @RequirePermissions(PERMISSIONS.PROPOSAL_WRITE)
  send(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.proposals.send(user, id);
  }

  /** The customer refused the sent revision (the reason is mandatory). */
  @Post(':id/reject')
  @RequirePermissions(PERMISSIONS.PROPOSAL_WRITE)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectProposalDto) {
    return this.proposals.rejectByCustomer(user, id, dto);
  }

  @Post(':id/revisions/:revisionId/accept')
  @RequirePermissions(PERMISSIONS.PROPOSAL_WRITE)
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
  ) {
    return this.proposals.acceptRevision(user, id, revisionId);
  }
}
