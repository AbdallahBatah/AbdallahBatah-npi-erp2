'use client';

import { ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icons';
import { NotificationsBell } from '@/components/notifications';
import { GlobalSearch } from '@/components/global-search';
import { ChangePasswordButton } from '@/components/change-password';

interface NavItem {
  href: string;
  key: string;
  icon: string;
  /** Required read permission; omitted = visible to everyone. */
  perm?: string;
}
interface NavSection {
  labelAr: string;
  labelEn: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
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
      { href: '/admin', key: 'nav.admin', icon: 'shield-users', perm: 'admin.user.manage' },
    ],
  },
];

const ROLE_LABELS: Record<string, { ar: string; en: string }> = {
  admin: { ar: 'مسؤول النظام', en: 'Administrator' },
  sales: { ar: 'مبيعات', en: 'Sales' },
  accountant: { ar: 'محاسب', en: 'Accountant' },
  pm: { ar: 'مدير مشاريع', en: 'Project Manager' },
  site_engineer: { ar: 'مهندس موقع', en: 'Site Engineer' },
  finance: { ar: 'مالية', en: 'Finance' },
  ops: { ar: 'تشغيل', en: 'Operations' },
};

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading, logout, can } = useAuth();
  const { t, pick, locale, toggle } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile drawer when navigating.
  useEffect(() => setNavOpen(false), [pathname]);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:hidden">
        <button
          aria-label={locale === 'ar' ? 'فتح القائمة' : 'Open menu'}
          onClick={() => setNavOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="text-sm font-bold text-slate-900">{t('app.name')}</span>
      </header>
      {/* Mobile overlay */}
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink-950/60 lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 start-0 z-50 flex w-[264px] flex-col border-e border-white/[0.04] bg-gradient-to-b from-ink-900 via-ink-950 to-ink-950 text-slate-300 lg:z-40 ${
          navOpen ? '' : 'max-lg:hidden'
        }`}
      >
        {/* Brand */}
        <div className="relative px-5 pb-5 pt-6">
          {/* soft teal aura behind the mark */}
          <div className="pointer-events-none absolute -top-10 start-2 h-32 w-32 rounded-full bg-brand-500/10 blur-2xl" />
          <div className="relative flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 via-brand-500 to-brand-700 text-white shadow-glow ring-1 ring-white/20">
              <Icon name="sun" className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-bold leading-tight text-white">
                {t('app.name')}
              </p>
              <p className="mt-0.5 truncate text-[10.5px] text-slate-500">
                {pick(user.organization, 'name')}
              </p>
            </div>
          </div>
        </div>

        <div className="mx-5 h-px bg-gradient-to-l from-transparent via-white/10 to-transparent" />

        {/* Nav */}
        <nav className="flex-1 space-y-6 overflow-y-auto px-3.5 pb-4 pt-5 [scrollbar-width:thin]">
          {NAV_SECTIONS.map((section) => {
            // Only show pages this role can actually open (and drop empty groups).
            const visible = section.items.filter((i) => !i.perm || can(i.perm));
            if (visible.length === 0) return null;
            return (
            <div key={section.labelEn}>
              <p className="mb-2 flex items-center gap-2 px-2.5 text-[11px] font-bold text-slate-400">
                {locale === 'ar' ? section.labelAr : section.labelEn}
                <span className="h-px flex-1 bg-white/[0.05]" />
              </p>
              <div className="space-y-[3px]">
                {visible.map((item) => {
                  const active = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={`group relative flex items-center gap-3 rounded-lg py-[9px] pe-3 ps-3.5 text-[13px] transition-all duration-150 ${
                        active
                          ? 'bg-gradient-to-l from-brand-500/[0.16] to-brand-500/[0.05] font-semibold text-brand-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                          : 'font-medium text-slate-400 hover:bg-white/[0.045] hover:text-slate-100'
                      }`}
                    >
                      {active && (
                        <span className="absolute inset-y-[7px] start-0 w-[3px] rounded-full bg-gradient-to-b from-brand-300 to-brand-500 shadow-[0_0_8px_rgba(45,212,191,0.6)]" />
                      )}
                      <Icon
                        name={item.icon}
                        className={`h-[18px] w-[18px] shrink-0 transition-colors duration-150 ${
                          active ? 'text-brand-300' : 'text-slate-500 group-hover:text-slate-300'
                        }`}
                      />
                      <span className="truncate">{t(item.key)}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="border-t border-white/[0.06] p-3.5">
          {/* Segmented language toggle */}
          <div className="mb-2.5 grid grid-cols-2 gap-1 rounded-lg bg-white/[0.04] p-1">
            {(['ar', 'en'] as const).map((l) => (
              <button
                key={l}
                onClick={() => locale !== l && toggle()}
                className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-semibold transition ${
                  locale === l
                    ? 'bg-white/10 text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {l === 'ar' ? 'العربية' : 'English'}
              </button>
            ))}
          </div>

          {/* User card */}
          <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.05] bg-white/[0.03] px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500/40 to-brand-700/40 text-xs font-bold text-brand-200 ring-1 ring-brand-400/30">
                {pick(user, 'name').charAt(0)}
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-slate-200">
                  {pick(user, 'name')}
                </p>
                <p className="truncate text-[10px] text-slate-400">
                  {(() => {
                    // Custom roles carry their own display names from the server.
                    const own = locale === 'ar' ? user.roleNameAr : user.roleNameEn;
                    if (own) return own;
                    const r = ROLE_LABELS[user.roleKey?.toLowerCase() ?? ''];
                    return r ? (locale === 'ar' ? r.ar : r.en) : user.roleKey;
                  })()}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center">
              <ChangePasswordButton />
              <button
                onClick={logout}
                title={t('nav.logout')}
                aria-label={t('nav.logout')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-400 rtl:-scale-x-100"
              >
                <Icon name="log-out" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      <GlobalSearch />
      <NotificationsBell />

      {/* lg:pt-16 keeps page headers clear of the floating bell. */}
      <main className="flex-1 overflow-x-auto p-4 pt-20 lg:ms-[264px] lg:p-8 lg:pt-16">
        <div className="mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
