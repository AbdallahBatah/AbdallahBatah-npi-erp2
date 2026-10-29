import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ContractsService } from './contracts.service';
import { CreateContractDto, UpdateContractDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('contracts')
@UseGuards(PermissionsGuard)
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CONTRACT_READ)
  list(@CurrentUser() user: AuthUser) {
    return this.contracts.list(user);
  }

  /** Package 2 · P2-4: contracts waiting on the caller's signature (general manager's card). */
  @Get('awaiting-me')
  @RequirePermissions(PERMISSIONS.PROPOSAL_APPROVE)
  awaitingMe(@CurrentUser() user: AuthUser) {
    return this.contracts.awaitingMyApproval(user);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CONTRACT_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contracts.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateContractDto) {
    return this.contracts.create(user, dto);
  }

  /** Package 2 · P2-1: a draft's terms and payments. */
  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateContractDto) {
    return this.contracts.update(user, id, dto);
  }

  /** Package 2 · P2-2: raise a draft to the general manager (payments must sum to the value). */
  @Post(':id/submit')
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  submit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contracts.submit(user, id);
  }

  @Post(':id/activate')
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  activate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contracts.activate(user, id);
  }

  @Post(':id/milestones/:milestoneId/verify')
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  verifyMilestone(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('milestoneId') milestoneId: string,
  ) {
    return this.contracts.verifyMilestone(user, id, milestoneId);
  }
}
