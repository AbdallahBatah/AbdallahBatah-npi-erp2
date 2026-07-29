import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ContractsService } from './contracts.service';
import { CreateContractDto } from './dto';
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
