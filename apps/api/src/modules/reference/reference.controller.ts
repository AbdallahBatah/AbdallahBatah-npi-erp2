import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CurrentUser,
  RequirePermissions,
  SkipPermissions,
} from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';
import { PERMISSIONS } from '@npi/shared';
import {
  CUSTOMER_TYPES,
  CUSTOMER_ENTITY_KINDS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TYPES,
  OPPORTUNITY_STAGE_FLOW,
  ITEM_CATEGORIES,
  PROPOSAL_STATUSES,
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
 * lists (from @npi/shared) plus tenant-scoped pricing schemes.
 */
@Controller('reference')
export class ReferenceController {
  constructor(private readonly prisma: PrismaService) {}

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
      itemCategories: ITEM_CATEGORIES,
      proposalStatuses: PROPOSAL_STATUSES,
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
    const [leads, openOpps, contracts, activeContracts, pipeline] = await Promise.all([
      this.prisma.lead.count({ where: { organizationId: org, status: { not: 'CONVERTED' } } }),
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
}
