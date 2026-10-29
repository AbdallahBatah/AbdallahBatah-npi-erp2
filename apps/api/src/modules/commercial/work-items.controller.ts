import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { WorkItemsService } from './work-items.service';
import { CreateWorkItemDto, UpdateWorkItemDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

/**
 * Package 3 · P3-3 — project work items, managed on the items screen under its
 * keys (ADR-03 §4-3, deviation recorded there: no screen or key of its own).
 * The budget editor reads them through GET /reference/lookups/work-items.
 */
@Controller('work-items')
@UseGuards(PermissionsGuard)
export class WorkItemsController {
  constructor(private readonly workItems: WorkItemsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ITEM_READ)
  list(@CurrentUser() user: AuthUser, @Query('all') all?: string, @Query('search') search?: string) {
    return this.workItems.list(user, all === '1' || all === 'true', search);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ITEM_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkItemDto) {
    return this.workItems.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ITEM_WRITE)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateWorkItemDto) {
    return this.workItems.update(user, id, dto);
  }
}
