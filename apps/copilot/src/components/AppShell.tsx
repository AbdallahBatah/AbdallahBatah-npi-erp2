'use client';

import { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ExternalLink, Home, ClipboardList, Settings, Shield, BarChart3, BookUser, LogOut } from 'lucide-react';
import { t, type ArKey } from '@/i18n/ar';
import { npiWebUrl } from '@/npi/web-url';

interface NavItem {
  href: string;
  key: ArKey;
  Icon: typeof Home;
  /** Visible only to admins (spec/madar/01 §5: trust, metrics, settings). */
  adminOnly: boolean;
  /** False until the screen exists. A link to a screen that is not built
   *  yet would lead to a 404, so it is not shown. */
  ready: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', key: 'nav.home', Icon: Home, adminOnly: false, ready: true },
  // Setup arrived with T-18, settings with T-19, handover with T-30. Trust
  // arrived with T-33; metrics arrives with T-35: each flips its flag in the
  // task that builds it.
  { href: '/setup', key: 'nav.setup', Icon: ClipboardList, adminOnly: true, ready: true },
  { href: '/settings', key: 'nav.settings', Icon: Settings, adminOnly: true, ready: true },
  { href: '/trust', key: 'nav.trust', Icon: Shield, adminOnly: true, ready: true },
  { href: '/metrics', key: 'nav.metrics', Icon: BarChart3, adminOnly: true, ready: false },
  { href: '/handover', key: 'nav.handover', Icon: BookUser, adminOnly: false, ready: true },
];

export interface AppShellProps {
  userName: string;
  isAdmin: boolean;
  onLogout?: () => void;
  children: ReactNode;
}

/**
 * NPI-like shell: a dark `ink` header (app name, "back to NPI", user + logout),
 * an inline-start side rail on desktop (`md:` and up) that becomes a bottom
 * tab bar fixed to the viewport on mobile — same items either way. Basic
 * screens (trust/metrics/settings) are admin-only per spec/madar/01 §5;
 * home and handover are visible to every role.
 */
export function AppShell({ userName, isAdmin, onLogout, children }: AppShellProps) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) => item.ready && (isAdmin || !item.adminOnly));
  const npiHomeUrl = npiWebUrl('/');

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : (pathname ?? '').startsWith(href);

  return (
    <div className="flex min-h-screen flex-col bg-[#f4f6f8]">
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-3 bg-ink-950 px-4 text-slate-100 md:h-16">
        <div className="flex min-w-0 items-center gap-2">
          <img src="/copilot/brand/npi-icon.svg" alt="" className="h-7 w-7 shrink-0" />
          <span className="truncate text-sm font-bold text-white">{t('app.name')}</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          <a
            href={npiHomeUrl}
            className="hidden min-h-11 items-center gap-1.5 text-xs font-semibold text-white underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 sm:flex"
          >
            <ExternalLink className="h-4 w-4 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
            {t('nav.back_to_npi')}
          </a>
          <span className="hidden max-w-[10rem] truncate text-xs text-slate-300 sm:inline">
            {userName}
          </span>
          <button
            type="button"
            onClick={onLogout}
            aria-label={t('logout')}
            className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <LogOut className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
            <span className="hidden sm:inline">{t('logout')}</span>
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <nav
          aria-label={t('nav.main')}
          className="fixed inset-x-0 bottom-0 z-30 flex min-h-[var(--copilot-tabbar-h)] items-stretch justify-around border-t border-white/10 bg-ink-900 pb-[env(safe-area-inset-bottom)] text-slate-300 md:static md:inset-auto md:z-auto md:min-h-0 md:w-56 md:shrink-0 md:flex-col md:items-stretch md:justify-start md:gap-1 md:border-e md:border-t-0 md:p-3"
        >
          {items.map(({ href, key, Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-xs font-medium transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
                  'md:flex-none md:flex-row md:justify-start md:gap-2.5 md:rounded-lg md:px-3 md:py-2.5 md:text-sm',
                  active
                    ? 'text-brand-300 md:bg-gradient-to-r md:from-brand-500/[0.16] md:to-brand-500/[0.05] md:font-semibold md:text-brand-200 md:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] md:rtl:bg-gradient-to-l'
                    : 'text-slate-400 hover:text-slate-100',
                ].join(' ')}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-2 start-0 hidden w-[3px] rounded-full bg-gradient-to-b from-brand-300 to-brand-500 shadow-[0_0_8px_rgba(45,212,191,0.6)] md:block"
                  />
                ) : null}
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="truncate">{t(key)}</span>
              </Link>
            );
          })}
          {/* Phones have no header "back to NPI" link (that one only shows
              from `sm` up) — this is their way out to NPI's own app. */}
          <a
            href={npiHomeUrl}
            className="flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-xs font-medium text-slate-400 transition hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 md:hidden"
          >
            <ExternalLink className="h-5 w-5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
            <span className="truncate">{t('nav.back_to_npi')}</span>
          </a>
        </nav>

        <main id="main" className="min-w-0 flex-1 px-4 pb-20 pt-4 md:pb-8 md:pt-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
