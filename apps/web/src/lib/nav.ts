/**
 * The application's navigation map — one source of truth, consumed by both the
 * sidebar and the global search's command entries. Keeping it here means a new
 * screen becomes reachable from Ctrl+K the moment it appears in the sidebar,
 * with the same permission gate applied in both places.
 */
export interface NavItem {
  href: string;
  key: string;
  icon: string;
  /** Required read permission; omitted = visible to everyone. */
  perm?: string;
}

export interface NavSection {
  labelAr: string;
  labelEn: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    labelAr: 'المبيعات والتعاقد',
    labelEn: 'Sales & contracting',
    items: [
      { href: '/dashboard', key: 'nav.dashboard', icon: 'dashboard' },
      { href: '/leads', key: 'nav.leads', icon: 'target', perm: 'crm.lead.read' },
      { href: '/customers', key: 'nav.customers', icon: 'users', perm: 'crm.customer.read' },
      { href: '/opportunities', key: 'nav.opportunities', icon: 'lightbulb', perm: 'crm.opportunity.read' },
      // CRM Step 5: the team's follow-up tasks (the inbox shows only the caller's own, due today or late).
      { href: '/tasks', key: 'nav.tasks', icon: 'square-check', perm: 'crm.customer.read' },
      { href: '/proposals', key: 'nav.proposals', icon: 'file-text', perm: 'commercial.proposal.read' },
      { href: '/contracts', key: 'nav.contracts', icon: 'file-signature', perm: 'commercial.contract.read' },
    ],
  },
  {
    labelAr: 'التنفيذ والتوريد',
    labelEn: 'Delivery & supply',
    items: [
      { href: '/projects', key: 'nav.projects', icon: 'building', perm: 'projects.project.read' },
      { href: '/requisitions', key: 'nav.requisitions', icon: 'file-text', perm: 'scm.procurement.read' },
      { href: '/procurement', key: 'nav.procurement', icon: 'cart', perm: 'scm.procurement.read' },
      { href: '/assets', key: 'nav.assets', icon: 'scan', perm: 'assets.serialunit.read' },
      { href: '/items', key: 'nav.items', icon: 'package', perm: 'commercial.item.read' },
    ],
  },
  {
    labelAr: 'التشغيل',
    labelEn: 'Operations',
    items: [
      { href: '/workorders', key: 'nav.workorders', icon: 'wrench', perm: 'fsm.workorder.read' },
    ],
  },
  {
    labelAr: 'المالية',
    labelEn: 'Finance',
    items: [
      { href: '/invoices', key: 'nav.invoices', icon: 'receipt', perm: 'finance.invoice.read' },
      { href: '/payables', key: 'nav.payables', icon: 'wallet', perm: 'finance.payment.read' },
      { href: '/finance', key: 'nav.finance', icon: 'bar-chart', perm: 'finance.ledger.read' },
      { href: '/statements', key: 'nav.statements', icon: 'scale', perm: 'finance.ledger.read' },
      { href: '/ledger', key: 'nav.ledger', icon: 'book', perm: 'finance.ledger.read' },
    ],
  },
  {
    labelAr: 'الإدارة',
    labelEn: 'Administration',
    items: [
      // No `perm` on either: both are self-scoped to the caller's own role by
      // the server, so every user needs to reach them — including ones who
      // administer nothing.
      { href: '/inbox', key: 'nav.inbox', icon: 'square-check' },
      { href: '/approvals', key: 'nav.approvals', icon: 'stamp' },
      // The Madar copilot (T-08): a separate Next.js app mounted at
      // `/copilot`, outside this app's own routes. No `perm` — every user
      // may open the assistant, same reasoning as inbox/approvals above.
      { href: '/copilot', key: 'nav.madar', icon: 'message-circle' },
      { href: '/admin', key: 'nav.admin', icon: 'shield-users', perm: 'admin.user.manage' },
      // M4's two organisation-structure screens. They are separate routes, not
      // tabs of /admin, because their permissions are separate: an
      // organization can hand someone the department list or the delegation
      // register without also handing them user and role administration.
      { href: '/departments', key: 'nav.departments', icon: 'building', perm: 'admin.department.manage' },
      { href: '/delegations', key: 'nav.delegations', icon: 'key', perm: 'admin.delegation.manage' },
    ],
  },
];

/** Flat list — what the command palette searches over. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
