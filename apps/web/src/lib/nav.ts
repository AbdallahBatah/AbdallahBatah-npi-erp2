/**
 * The application's navigation map — one source of truth, consumed by both the
 * sidebar and the global search's command entries. Keeping it here means a new
 * screen becomes reachable from Ctrl+K the moment it appears in the sidebar,
 * with the same permission gate applied in both places.
 *
 * Which screens exist, their group, their order and the key that opens each
 * come from the shared screen registry (packages/shared/src/screens.ts, ADR-02
 * §3-6), which the role and user editors' previews read too, and where the
 * reasons for each screen's placement are written down. This file adds only
 * the web app's own part: the i18n key and the icon.
 */
import { SCREEN_GROUPS, SCREENS, type ScreenHref } from '@npi/shared';

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

/** The i18n key and icon of every registry screen; a screen missing here does not compile. */
const NAV_META: Record<ScreenHref, { key: string; icon: string }> = {
  '/dashboard': { key: 'nav.dashboard', icon: 'dashboard' },
  '/inbox': { key: 'nav.inbox', icon: 'square-check' },
  '/approvals': { key: 'nav.approvals', icon: 'stamp' },
  '/copilot': { key: 'nav.madar', icon: 'message-circle' },
  '/leads': { key: 'nav.leads', icon: 'target' },
  '/customers': { key: 'nav.customers', icon: 'users' },
  '/opportunities': { key: 'nav.opportunities', icon: 'lightbulb' },
  '/tasks': { key: 'nav.tasks', icon: 'square-check' },
  '/proposals': { key: 'nav.proposals', icon: 'file-text' },
  '/contracts': { key: 'nav.contracts', icon: 'file-signature' },
  '/projects': { key: 'nav.projects', icon: 'building' },
  '/requisitions': { key: 'nav.requisitions', icon: 'file-text' },
  '/procurement': { key: 'nav.procurement', icon: 'cart' },
  '/assets': { key: 'nav.assets', icon: 'scan' },
  '/items': { key: 'nav.items', icon: 'package' },
  '/workorders': { key: 'nav.workorders', icon: 'wrench' },
  '/invoices': { key: 'nav.invoices', icon: 'receipt' },
  '/payables': { key: 'nav.payables', icon: 'wallet' },
  '/finance': { key: 'nav.finance', icon: 'bar-chart' },
  '/statements': { key: 'nav.statements', icon: 'scale' },
  '/ledger': { key: 'nav.ledger', icon: 'book' },
  '/admin': { key: 'nav.admin', icon: 'shield-users' },
  '/departments': { key: 'nav.departments', icon: 'building' },
  '/delegations': { key: 'nav.delegations', icon: 'key' },
};

export const NAV_SECTIONS: NavSection[] = SCREEN_GROUPS.map((group) => ({
  labelAr: group.labelAr,
  labelEn: group.labelEn,
  items: SCREENS.filter((s) => s.group === group.key).map((s) => ({
    href: s.href,
    ...NAV_META[s.href],
    // A screen with no view key carries no `perm`, as before the registry.
    ...(s.view ? { perm: s.view } : {}),
  })),
}));

/** Flat list — what the command palette searches over. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
