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
      { href: '/telemetry', key: 'nav.telemetry', icon: 'activity', perm: 'fsm.workorder.read' },
      { href: '/ppa', key: 'nav.ppa', icon: 'zap', perm: 'finance.invoice.read' },
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
      { href: '/admin', key: 'nav.admin', icon: 'shield-users', perm: 'admin.user.manage' },
    ],
  },
];

/** Flat list — what the command palette searches over. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
