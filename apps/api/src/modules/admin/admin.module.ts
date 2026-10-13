import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { DelegationsController } from './delegations.controller';
import { DelegationsService } from './delegations.service';
import { RolePresetsController } from './role-presets.controller';
import { RolePresetsService } from './role-presets.service';
import { ApprovalRulesService } from '../approvals/approvals.service';

/**
 * User & role administration (the tenant's own self-service — not superadmin),
 * plus the two M4 organisation-structure resources that shipped as tables with
 * no HTTP surface: departments and temporary approval delegations. They live
 * here because they are administered from the same screen and by the same
 * people; the *use* of a delegation stays in the kernel, where the approval
 * matrix reads it.
 */
@Module({
  controllers: [AdminController, DepartmentsController, DelegationsController, RolePresetsController],
  // ApprovalRulesService (stateless) is provided here as well, for the role
  // presets' rule apply, rather than exported from ApprovalsModule.
  providers: [AdminService, DepartmentsService, DelegationsService, RolePresetsService, ApprovalRulesService],
})
export class AdminModule {}
