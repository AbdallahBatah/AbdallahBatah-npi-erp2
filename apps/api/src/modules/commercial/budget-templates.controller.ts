import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { BudgetTemplatesService } from './budget-templates.service';
import { CreateBudgetTemplateDto, UpdateBudgetTemplateDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

/**
 * Package 3 · P3-5 — standard estimated budgets, on the items screen under its
 * keys. The budget editor reads them through GET /reference/lookups/budget-templates.
 */
@Controller('budget-templates')
@UseGuards(PermissionsGuard)
export class BudgetTemplatesController {
  constructor(private readonly templates: BudgetTemplatesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ITEM_READ)
  list(@CurrentUser() user: AuthUser, @Query('all') all?: string) {
    return this.templates.list(user, all === '1' || all === 'true');
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ITEM_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBudgetTemplateDto) {
    return this.templates.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ITEM_WRITE)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateBudgetTemplateDto) {
    return this.templates.update(user, id, dto);
  }
}
