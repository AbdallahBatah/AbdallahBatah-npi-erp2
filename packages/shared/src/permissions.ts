/**
 * The complete permission surface for the current build slice.
 * Format: `<module>.<entity>.<action>`. The seed grants the full set to the
 * `admin` role and a read/write subset to `sales`.
 */
export const PERMISSIONS = {
  CUSTOMER_READ: 'crm.customer.read',
  CUSTOMER_WRITE: 'crm.customer.write',
  LEAD_READ: 'crm.lead.read',
  LEAD_WRITE: 'crm.lead.write',
  OPPORTUNITY_READ: 'crm.opportunity.read',
  OPPORTUNITY_WRITE: 'crm.opportunity.write',
  ITEM_READ: 'commercial.item.read',
  ITEM_WRITE: 'commercial.item.write',
  PROPOSAL_READ: 'commercial.proposal.read',
  PROPOSAL_WRITE: 'commercial.proposal.write',
  CONTRACT_READ: 'commercial.contract.read',
  CONTRACT_WRITE: 'commercial.contract.write',
  INVOICE_READ: 'finance.invoice.read',
  INVOICE_WRITE: 'finance.invoice.write',
  LEDGER_READ: 'finance.ledger.read',
  PAYMENT_READ: 'finance.payment.read',
  PAYMENT_WRITE: 'finance.payment.write',
  PROJECT_READ: 'projects.project.read',
  PROJECT_WRITE: 'projects.project.write',
  PROCUREMENT_READ: 'scm.procurement.read',
  PROCUREMENT_WRITE: 'scm.procurement.write',
  ASSET_READ: 'assets.serialunit.read',
  WORKORDER_READ: 'fsm.workorder.read',
  WORKORDER_WRITE: 'fsm.workorder.write',
  ORG_MANAGE: 'admin.org.manage',
  USER_MANAGE: 'admin.user.manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionKey[] = Object.values(PERMISSIONS);
