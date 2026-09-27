'use client';

import { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Settings, Shield, BarChart3, BookUser, LogOut } from 'lucide-react';
import { t, type ArKey } from '@/i18n/ar';

interface NavItem {
  href: string;
  key: ArKey;
  Icon: typeof Home;
  /** Visible only to admins (spec/madar/01 §5: trust, metrics, settings). */
  adminOnly: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', key: 'nav.home', Icon: Home, adminOnly: false },
  { href: '/settings', key: 'nav.settings', Icon: Settings, adminOnly: true },
  { href: '/trust', key: 'nav.trust', Icon: Shield, adminOnly: true },
  { href: '/metrics', key: 'nav.metrics', Icon: BarChart3, adminOnly: true },
  { href: '/handover', key: 'nav.handover', Icon: BookUser, adminOnly: false },
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
  const items = NAV_ITEMS.filter((item) => isAdmin || !item.adminOnly);
  const npiUrl = process.env.NEXT_PUBLIC_NPI_WEB_URL ?? '/';

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : (pathname ?? '').startsWith(href);

  return (
    <div className="flex min-h-screen flex-col bg-[#f4f6f8]">
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-3 bg-ink-950 px-4 text-slate-100 md:h-16">
        <span className="truncate text-sm font-bold text-white">{t('app.name')}</span>
        <div className="flex items-center gap-2 sm:gap-4">
          <a
            href={npiUrl}
            className="hidden text-xs font-medium text-slate-300 underline-offset-4 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 sm:inline"
          >
            {t('nav.back_to_npi')}
          </a>
          <span className="hidden max-w-[10rem] truncate text-xs text-slate-300 sm:inline">
            {userName}
          </span>
          <button
            type="button"
            onClick={onLogout}
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
          className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-white/10 bg-ink-900 pb-[env(safe-area-inset-bottom)] text-slate-300 md:static md:inset-auto md:z-auto md:w-56 md:shrink-0 md:flex-col md:items-stretch md:justify-start md:gap-1 md:border-e md:border-t-0 md:p-3"
        >
          {items.map(({ href, key, Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-xs font-medium transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
                  'md:flex-none md:flex-row md:justify-start md:gap-2.5 md:rounded-lg md:px-3 md:py-2.5 md:text-sm',
                  active
                    ? 'text-brand-300 md:bg-white/[0.06] md:text-brand-200'
                    : 'text-slate-400 hover:text-slate-100',
                ].join(' ')}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="truncate">{t(key)}</span>
              </Link>
            );
          })}
        </nav>

        <main id="main" className="flex-1 px-4 pb-20 pt-4 md:pb-8 md:pt-6">
          {children}
        </main>
      </div>
    </div>
  );
}
