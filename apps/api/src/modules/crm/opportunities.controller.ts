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
import { OpportunitiesService } from './opportunities.service';
import { CreateOpportunityDto, UpdateOpportunityDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('opportunities')
@UseGuards(PermissionsGuard)
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.OPPORTUNITY_READ)
  list(@CurrentUser() user: AuthUser, @Query('stage') stage?: string) {
    return this.opportunities.list(user, stage);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.OPPORTUNITY_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.opportunities.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.OPPORTUNITY_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOpportunityDto) {
    return this.opportunities.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.OPPORTUNITY_WRITE)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateOpportunityDto,
  ) {
    return this.opportunities.update(user, id, dto);
  }
}
