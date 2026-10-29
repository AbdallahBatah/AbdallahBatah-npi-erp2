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
import { LeadsService } from './leads.service';
import { ConvertLeadDto, CreateLeadDto, SetLeadStatusDto, UpdateLeadDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('leads')
@UseGuards(PermissionsGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.leads.list(
      user,
      status,
      search,
      take !== undefined ? Math.min(Number(take) || 25, 200) : undefined,
      skip !== undefined ? Number(skip) || 0 : undefined,
    );
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.leads.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.LEAD_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeadDto) {
    return this.leads.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.LEAD_WRITE)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
  ) {
    return this.leads.update(user, id, dto);
  }

  @Post(':id/convert')
  @RequirePermissions(PERMISSIONS.LEAD_WRITE, PERMISSIONS.OPPORTUNITY_WRITE)
  convert(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
  ) {
    return this.leads.convert(user, id, dto);
  }

  /**
   * Package 3 · P3-1 — negotiation outcome: ACCEPTED converts into an
   * opportunity (the service also demands crm.opportunity.write), REJECTED
   * needs a reason, NEGOTIATING reopens a rejected lead.
   */
  @Post(':id/status')
  @RequirePermissions(PERMISSIONS.LEAD_WRITE)
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetLeadStatusDto,
  ) {
    return this.leads.setStatus(user, id, dto);
  }
}
