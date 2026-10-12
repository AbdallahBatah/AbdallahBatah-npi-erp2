/**
 * The screen registry (ADR-02 §3-6): every sidebar screen with its group, its
 * path and the view key that opens it, in sidebar order. It is the one place
 * that decides which screens a user sees. The web sidebar and quick search
 * (apps/web/src/lib/nav.ts, which adds only the icon and the i18n key), the
 * page guard (`screenForPath`) and the previews of the role and user editors
 * all read it through `visibleScreens`, so a preview cannot drift from what
 * the user then actually sees.
 *
 * One view key per screen that has one (ADR-02 hard rule 5), enforced by
 * apps/api/src/common/screens.spec.ts. The keys still shared by two or three
 * screens are listed in SHARED_VIEW_KEYS_UNTIL_P1_6 and nowhere else.
 *
 * Imports only from `./permissions`, never the reverse: that file must stay
 * import-free (apps/copilot/tests/catalog.spec.ts reads it by relative path).
 */
import { PERMISSIONS, type PermissionKey } from './permissions';

export type ScreenGroupKey =
  'general' | 'sales' | 'delivery' | 'operations' | 'finance' | 'admin';

export interface ScreenGroup {
  key: ScreenGroupKey;
  labelAr: string;
  labelEn: string;
}

/** The sidebar's groups, in sidebar order. */
export const SCREEN_GROUPS: readonly ScreenGroup[] = [
  // The screens every user may open: none of them has a view key, so this
  // group is never empty and always comes first (ADR-02 §3-5).
  { key: 'general', labelAr: 'عام', labelEn: 'General' },
  { key: 'sales', labelAr: 'المبيعات والتعاقد', labelEn: 'Sales & contracting' },
  { key: 'delivery', labelAr: 'التنفيذ والتوريد', labelEn: 'Delivery & supply' },
  { key: 'operations', labelAr: 'التشغيل', labelEn: 'Operations' },
  { key: 'finance', labelAr: 'المالية', labelEn: 'Finance' },
  { key: 'admin', labelAr: 'الإدارة', labelEn: 'Administration' },
];

interface ScreenEntry {
  href: string;
  group: ScreenGroupKey;
  /** The key that opens the screen; absent = every user may open it. */
  view?: PermissionKey;
  /**
   * The sidebar label — the web app's `nav.*` strings (apps/web/src/lib/messages.ts),
   * repeated here so the admin editors can name a row without the web i18n.
   */
  labelAr: string;
  labelEn: string;
}

const SCREEN_ENTRIES = [
  // ── General ──
  // The landing page. No view key: every tile on it is gated by the key of
  // its own data, and a user without the dashboard would have no landing page.
  { href: '/dashboard', group: 'general', labelAr: 'لوحة المعلومات', labelEn: 'Dashboard' },
  // No view key on either: both are self-scoped to the caller's own role by
  // the server, so every user needs to reach them — including ones who
  // administer nothing. Hiding them would hide a person's own commitments and
  // stall the approval chains waiting on them.
  { href: '/inbox', group: 'general', labelAr: 'صندوق المهام', labelEn: 'Task box' },
  { href: '/approvals', group: 'general', labelAr: 'الاعتمادات', labelEn: 'Approvals' },
  // The Madar copilot (T-08): a separate Next.js app mounted at `/copilot`,
  // outside the web app's own routes, with its own session. No view key —
  // every user may open the assistant, same reasoning as inbox/approvals
  // above, and a key on its link would hide it without blocking it.
  { href: '/copilot', group: 'general', labelAr: 'مساعد مَدار', labelEn: 'Madar assistant' },

  // ── Sales & contracting ──
  {
    href: '/leads',
    group: 'sales',
    view: PERMISSIONS.LEAD_READ,
    labelAr: 'العملاء المحتملون',
    labelEn: 'Leads',
  },
  {
    href: '/customers',
    group: 'sales',
    view: PERMISSIONS.CUSTOMER_READ,
    labelAr: 'العملاء',
    labelEn: 'Customers',
  },
  {
    href: '/opportunities',
    group: 'sales',
    view: PERMISSIONS.OPPORTUNITY_READ,
    labelAr: 'الفرص',
    labelEn: 'Opportunities',
  },
  // CRM Step 5: the team's follow-up tasks (the inbox shows only the caller's
  // own, due today or late). Shares the customers' key until P1-6.
  {
    href: '/tasks',
    group: 'sales',
    view: PERMISSIONS.CUSTOMER_READ,
    labelAr: 'مهام المتابعة',
    labelEn: 'Follow-up tasks',
  },
  {
    href: '/proposals',
    group: 'sales',
    view: PERMISSIONS.PROPOSAL_READ,
    labelAr: 'العروض',
    labelEn: 'Proposals',
  },
  {
    href: '/contracts',
    group: 'sales',
    view: PERMISSIONS.CONTRACT_READ,
    labelAr: 'العقود',
    labelEn: 'Contracts',
  },

  // ── Delivery & supply ──
  {
    href: '/projects',
    group: 'delivery',
    view: PERMISSIONS.PROJECT_READ,
    labelAr: 'المشاريع',
    labelEn: 'Projects',
  },
  // Shares procurement's key until P1-6.
  {
    href: '/requisitions',
    group: 'delivery',
    view: PERMISSIONS.PROCUREMENT_READ,
    labelAr: 'طلبات الشراء',
    labelEn: 'Requisitions',
  },
  {
    href: '/procurement',
    group: 'delivery',
    view: PERMISSIONS.PROCUREMENT_READ,
    labelAr: 'المشتريات',
    labelEn: 'Procurement',
  },
  {
    href: '/assets',
    group: 'delivery',
    view: PERMISSIONS.ASSET_READ,
    labelAr: 'الأصول المتسلسلة',
    labelEn: 'Serialised assets',
  },
  {
    href: '/items',
    group: 'delivery',
    view: PERMISSIONS.ITEM_READ,
    labelAr: 'الأصناف',
    labelEn: 'Items',
  },

  // ── Operations ──
  {
    href: '/workorders',
    group: 'operations',
    view: PERMISSIONS.WORKORDER_READ,
    labelAr: 'التشغيل والصيانة',
    labelEn: 'O&M',
  },

  // ── Finance ──
  {
    href: '/invoices',
    group: 'finance',
    view: PERMISSIONS.INVOICE_READ,
    labelAr: 'الفواتير',
    labelEn: 'Invoices',
  },
  {
    href: '/payables',
    group: 'finance',
    view: PERMISSIONS.PAYMENT_READ,
    labelAr: 'مستحقات الموردين',
    labelEn: 'Vendor payables',
  },
  // The three accounting screens share the ledger's key until P1-6.
  {
    href: '/finance',
    group: 'finance',
    view: PERMISSIONS.LEDGER_READ,
    labelAr: 'التقارير المالية',
    labelEn: 'Finance reports',
  },
  {
    href: '/statements',
    group: 'finance',
    view: PERMISSIONS.LEDGER_READ,
    labelAr: 'القوائم المالية',
    labelEn: 'Financial statements',
  },
  {
    href: '/ledger',
    group: 'finance',
    view: PERMISSIONS.LEDGER_READ,
    labelAr: 'دفتر الأستاذ',
    labelEn: 'General ledger',
  },

  // ── Administration ──
  {
    href: '/admin',
    group: 'admin',
    view: PERMISSIONS.USER_MANAGE,
    labelAr: 'المستخدمون والأدوار',
    labelEn: 'Users & roles',
  },
  // M4's two organisation-structure screens. They are separate routes, not
  // tabs of /admin, because their permissions are separate: an organization
  // can hand someone the department list or the delegation register without
  // also handing them user and role administration.
  {
    href: '/departments',
    group: 'admin',
    view: PERMISSIONS.DEPARTMENT_MANAGE,
    labelAr: 'الأقسام',
    labelEn: 'Departments',
  },
  {
    href: '/delegations',
    group: 'admin',
    view: PERMISSIONS.DELEGATION_MANAGE,
    labelAr: 'التفويضات المؤقتة',
    labelEn: 'Delegations',
  },
] as const satisfies readonly ScreenEntry[];

/** The path of a registered screen — a union of the registry's hrefs. */
export type ScreenHref = (typeof SCREEN_ENTRIES)[number]['href'];

export interface Screen extends ScreenEntry {
  href: ScreenHref;
}

/** Every sidebar screen, in sidebar order (grouped in SCREEN_GROUPS order). */
export const SCREENS: readonly Screen[] = SCREEN_ENTRIES;

/**
 * The only view keys allowed to open more than one screen, each with exactly
 * the screens it opens today. ADR-02 task 4 (P1-6) splits them —
 * `crm.task.read` takes /tasks, `scm.requisition.read` /requisitions,
 * `finance.report.read` /finance and `finance.statement.read` /statements —
 * and empties this object; the registry test then holds every view key to a
 * single screen. Do not add to it.
 */
export const SHARED_VIEW_KEYS_UNTIL_P1_6: Readonly<
  Partial<Record<PermissionKey, readonly ScreenHref[]>>
> = {
  'crm.customer.read': ['/customers', '/tasks'],
  'scm.procurement.read': ['/requisitions', '/procurement'],
  'finance.ledger.read': ['/finance', '/statements', '/ledger'],
};

/**
 * The screens a holder of `permissions` may open, in registry order: those with
 * no view key and those whose view key is held. Pure — the sidebar, the quick
 * search and both editors' previews call it with whatever set they have.
 */
export function visibleScreens(permissions: readonly string[]): Screen[] {
  const held = new Set(permissions);
  return SCREENS.filter((s) => s.view === undefined || held.has(s.view));
}

export interface VisibleGroup {
  group: ScreenGroup;
  screens: Screen[];
}

/** `visibleScreens` by sidebar group, empty groups dropped — what a sidebar renders. */
export function visibleGroups(permissions: readonly string[]): VisibleGroup[] {
  const screens = visibleScreens(permissions);
  return SCREEN_GROUPS.map((group) => ({
    group,
    screens: screens.filter((s) => s.group === group.key),
  })).filter((g) => g.screens.length > 0);
}

/**
 * The registry screen a path belongs to: the longest `href` that is the path
 * itself or a whole-segment prefix of it (`/customers/abc` → /customers; `/admin`
 * never matches `/administration`). `undefined` for a path outside every screen,
 * such as `/`. For the page guard (ADR-02 §3-5).
 */
export function screenForPath(pathname: string): Screen | undefined {
  let best: Screen | undefined;
  for (const s of SCREENS) {
    const inside = pathname === s.href || pathname.startsWith(`${s.href}/`);
    if (inside && (best === undefined || s.href.length > best.href.length)) best = s;
  }
  return best;
}
