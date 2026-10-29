import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
  SkipPermissions,
} from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';
import { LOOKUP_ACCESS, PERMISSIONS } from '@npi/shared';
import { ReferenceLookupsService } from './reference-lookups.service';
import {
  CUSTOMER_TYPES,
  CUSTOMER_ENTITY_KINDS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TYPES,
  OPPORTUNITY_STAGE_FLOW,
  ACTIVITY_TYPES,
  FOLLOWUP_TASK_STATUSES,
  ITEM_CATEGORIES,
  PROPOSAL_STATUSES,
  COST_SOURCES,
  CONTRACT_TYPES,
  CONTRACT_STATUSES,
  MILESTONE_TRIGGER_TYPES,
  MILESTONE_STATUSES,
  INVOICE_TYPES,
  INVOICE_STATUSES,
  PROJECT_STAGES,
  VENDOR_TYPES,
  PO_STATUSES,
  SERIAL_STATES,
  COST_TYPES,
  BILL_STATUSES,
  CHANGE_ORDER_STATUSES,
  SUBCONTRACT_STATUSES,
  CLAIM_STATUSES,
  LOCATION_TYPES,
  ASSET_TYPES,
  ASSET_STATUSES,
  WO_TYPES,
  WO_ORIGINS,
  WO_PRIORITIES,
  WO_STATUSES,
  ALERT_TYPES,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
} from '@npi/shared';

/**
 * Read-only reference data for populating web dropdowns: bilingual enum option
 * lists (from @npi/shared), tenant-scoped pricing schemes, and the pick lists
 * (items, projects, customers, vendors, locations) that any one of several
 * working keys earns.
 */
@Controller('reference')
export class ReferenceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookups: ReferenceLookupsService,
  ) {}

  /** Static bilingual labels needed by every page — permission-free by design. */
  @SkipPermissions()
  @Get('enums')
  enums() {
    return {
      customerTypes: CUSTOMER_TYPES,
      customerEntityKinds: CUSTOMER_ENTITY_KINDS,
      leadSources: LEAD_SOURCES,
      leadStatuses: LEAD_STATUSES,
      opportunityStages: OPPORTUNITY_STAGES,
      opportunityTypes: OPPORTUNITY_TYPES,
      activityTypes: ACTIVITY_TYPES,
      followUpTaskStatuses: FOLLOWUP_TASK_STATUSES,
      itemCategories: ITEM_CATEGORIES,
      proposalStatuses: PROPOSAL_STATUSES,
      costSources: COST_SOURCES,
      contractTypes: CONTRACT_TYPES,
      contractStatuses: CONTRACT_STATUSES,
      milestoneTriggerTypes: MILESTONE_TRIGGER_TYPES,
      milestoneStatuses: MILESTONE_STATUSES,
      invoiceTypes: INVOICE_TYPES,
      invoiceStatuses: INVOICE_STATUSES,
      projectStages: PROJECT_STAGES,
      vendorTypes: VENDOR_TYPES,
      poStatuses: PO_STATUSES,
      serialStates: SERIAL_STATES,
      costTypes: COST_TYPES,
      billStatuses: BILL_STATUSES,
      changeOrderStatuses: CHANGE_ORDER_STATUSES,
      subcontractStatuses: SUBCONTRACT_STATUSES,
      claimStatuses: CLAIM_STATUSES,
      locationTypes: LOCATION_TYPES,
      assetTypes: ASSET_TYPES,
      assetStatuses: ASSET_STATUSES,
      woTypes: WO_TYPES,
      woOrigins: WO_ORIGINS,
      woPriorities: WO_PRIORITIES,
      woStatuses: WO_STATUSES,
      alertTypes: ALERT_TYPES,
      alertSeverities: ALERT_SEVERITIES,
      alertStatuses: ALERT_STATUSES,
    };
  }

  @RequirePermissions(PERMISSIONS.PROPOSAL_READ)
  @Get('pricing-schemes')
  pricingSchemes(@CurrentUser() user: AuthUser) {
    return this.prisma.pricingScheme.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: { code: 'asc' },
    });
  }

  /** Dashboard summary (BI-01 seed): pipeline counts and open contract value.
   *  Aggregates CRM + contract data, so it requires CRM read access. */
  @RequirePermissions(PERMISSIONS.LEAD_READ)
  @Get('dashboard')
  async dashboard(@CurrentUser() user: AuthUser) {
    const org = user.organizationId;
    // The caller's own follow-up tasks (the dashboard card) are NOT here: they have their own
    // route, GET /tasks/summary, under the key that matches them (crm.customer.read). Putting
    // them behind this crm.lead.read endpoint hid the card from roles that may see tasks but
    // not leads (CRM Step 5-b).
    const [leads, openOpps, contracts, activeContracts, pipeline] = await Promise.all([
      this.prisma.lead.count({ where: { organizationId: org, status: 'NEGOTIATING' } }),
      this.prisma.opportunity.count({
        where: { organizationId: org, stage: { in: [...OPPORTUNITY_STAGE_FLOW] } },
      }),
      this.prisma.contract.count({ where: { organizationId: org } }),
      this.prisma.contract.count({ where: { organizationId: org, status: 'ACTIVE' } }),
      this.prisma.opportunity.aggregate({
        where: { organizationId: org, stage: { in: [...OPPORTUNITY_STAGE_FLOW] } },
        _sum: { estimatedValue: true },
      }),
    ]);
    return {
      openLeads: leads,
      openOpportunities: openOpps,
      totalContracts: contracts,
      activeContracts,
      pipelineValue: pipeline._sum.estimatedValue ?? 0,
    };
  }

  // ── Pick lists (ADR-02 §3-3) ──
  // A form's dropdown, names only, apart from the screen that owns the records:
  // any one key of the list's LOOKUP_ACCESS row is enough. The web pages ask
  // only when canUseLookup says so, and disable the field otherwise.

  @RequireAnyPermission(...LOOKUP_ACCESS.items)
  @Get('lookups/items')
  lookupItems(@CurrentUser() user: AuthUser) {
    return this.lookups.items(user.organizationId);
  }

  @RequireAnyPermission(...LOOKUP_ACCESS.projects)
  @Get('lookups/projects')
  lookupProjects(@CurrentUser() user: AuthUser) {
    return this.lookups.projects(user.organizationId);
  }

  @RequireAnyPermission(...LOOKUP_ACCESS.customers)
  @Get('lookups/customers')
  lookupCustomers(@CurrentUser() user: AuthUser) {
    return this.lookups.customers(user.organizationId);
  }

  @RequireAnyPermission(...LOOKUP_ACCESS.vendors)
  @Get('lookups/vendors')
  lookupVendors(@CurrentUser() user: AuthUser) {
    return this.lookups.vendors(user.organizationId);
  }

  @RequireAnyPermission(...LOOKUP_ACCESS.workItems)
  @Get('lookups/work-items')
  lookupWorkItems(@CurrentUser() user: AuthUser) {
    return this.lookups.workItems(user.organizationId);
  }

  @RequireAnyPermission(...LOOKUP_ACCESS.budgetTemplates)
  @Get('lookups/budget-templates')
  lookupBudgetTemplates(@CurrentUser() user: AuthUser) {
    return this.lookups.budgetTemplates(user.organizationId);
  }

  @RequireAnyPermission(...LOOKUP_ACCESS.locations)
  @Get('lookups/locations')
  lookupLocations(@CurrentUser() user: AuthUser) {
    return this.lookups.locations(user.organizationId);
  }
}
