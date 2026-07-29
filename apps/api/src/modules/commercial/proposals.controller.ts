import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ProposalsService } from './proposals.service';
import { CreateProposalDto, CreateRevisionDto } from './dto';
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
