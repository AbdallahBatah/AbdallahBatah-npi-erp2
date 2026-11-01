import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { ExecutionService } from './execution.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';
import { AttendanceDto, CheckOutDto, RecordProgressDto, RequestOverrunDto } from './execution.dto';

/**
 * Package 5 (ADR-05) — execution tracking. The engineer writes with the
 * project key (his preset holds it); reading is the projects screen's key.
 * Overruns are signed in the approval matrix, never here.
 */
@Controller('projects')
@UseGuards(PermissionsGuard)
export class ExecutionController {
  constructor(private readonly execution: ExecutionService) {}

  @Get(':id/execution')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  summary(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.execution.summary(user, id);
  }

  @Post(':id/progress')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  record(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RecordProgressDto) {
    return this.execution.recordProgress(user, id, dto);
  }

  @Delete('progress/:entryId')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  removeProgress(@CurrentUser() user: AuthUser, @Param('entryId') entryId: string) {
    return this.execution.deleteProgress(user, entryId);
  }

  @Post(':id/overruns')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  overrun(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RequestOverrunDto) {
    return this.execution.requestOverrun(user, id, dto);
  }

  /** The approvals inbox links an overrun by its own id; this resolves its project. */
  @Get('overruns/:overrunId')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  overrunRef(@CurrentUser() user: AuthUser, @Param('overrunId') overrunId: string) {
    return this.execution.overrunRef(user, overrunId);
  }

  @Get(':id/attendance')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  attendance(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('date') date?: string) {
    return this.execution.attendance(user, id, date);
  }

  @Post(':id/attendance')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  checkIn(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AttendanceDto) {
    return this.execution.checkIn(user, id, dto);
  }

  @Patch('attendance/:rowId')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  checkOut(@CurrentUser() user: AuthUser, @Param('rowId') rowId: string, @Body() dto: CheckOutDto) {
    return this.execution.checkOut(user, rowId, dto);
  }
}
