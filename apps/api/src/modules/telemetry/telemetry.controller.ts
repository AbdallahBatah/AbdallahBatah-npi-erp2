import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import { IngestDto, SimulateDto } from './dto';

@Controller('telemetry')
@UseGuards(PermissionsGuard)
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  /** TEL-01: batch ingestion (the integration service will call this). */
  @Post('readings')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  ingest(@CurrentUser() user: AuthUser, @Body() dto: IngestDto) {
    return this.telemetry.ingest(user, dto);
  }

  /** Simulated connector: generate a window of plant readings. */
  @Post('simulate')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  simulate(@CurrentUser() user: AuthUser, @Body() dto: SimulateDto) {
    return this.telemetry.simulate(user, dto);
  }

  @Get('readings')
  @RequirePermissions(PERMISSIONS.WORKORDER_READ)
  readings(
    @CurrentUser() user: AuthUser,
    @Query('assetId') assetId?: string,
    @Query('days') days?: string,
  ) {
    return this.telemetry.readings(user, assetId, days ? Number(days) : undefined);
  }

  @Get('alerts')
  @RequirePermissions(PERMISSIONS.WORKORDER_READ)
  alerts(@CurrentUser() user: AuthUser) {
    return this.telemetry.alerts(user);
  }

  @Post('alerts/:id/acknowledge')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  acknowledge(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.telemetry.acknowledge(user, id);
  }

  /** FSM-11 manual path for non-critical alerts. */
  @Post('alerts/:id/work-order')
  @RequirePermissions(PERMISSIONS.WORKORDER_WRITE)
  raiseWorkOrder(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.telemetry.raiseWorkOrder(user, id);
  }

  @Get('dashboard')
  @RequirePermissions(PERMISSIONS.WORKORDER_READ)
  dashboard(@CurrentUser() user: AuthUser) {
    return this.telemetry.dashboard(user);
  }

  /** AST-02: per-asset operating history. */
  @Get('assets/:id/history')
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  assetHistory(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.telemetry.assetHistory(user, id);
  }
}
