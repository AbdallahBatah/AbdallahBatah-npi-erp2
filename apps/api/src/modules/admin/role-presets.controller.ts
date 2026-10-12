import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@npi/shared';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';
import { RolePresetsService } from './role-presets.service';

/**
 * The seven company role presets and the five proposed approval rules
 * (ADR-02 §3-4, task 9): the preview the presets page draws, and the owner's
 * apply, one preset at a time or the five rules at once.
 *
 * `approval-rules/apply` is declared before `:key/apply`: Nest matches in
 * declaration order, so the static segment must never be read as a preset
 * key. Applying the rules edits the approval matrix, so it also needs the
 * matrix's own key.
 */
@Controller('admin/role-presets')
@UseGuards(PermissionsGuard)
export class RolePresetsController {
  constructor(private readonly presets: RolePresetsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  overview(@CurrentUser() user: AuthUser) {
    return this.presets.overview(user);
  }

  @Post('approval-rules/apply')
  @RequirePermissions(PERMISSIONS.USER_MANAGE, PERMISSIONS.APPROVAL_MANAGE)
  applyRules(@CurrentUser() user: AuthUser) {
    return this.presets.applyRules(user);
  }

  @Post(':key/apply')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  applyPreset(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.presets.applyPreset(user, key);
  }
}
