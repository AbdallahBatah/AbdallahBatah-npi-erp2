'use client';

/**
 * Ctrl+K / Cmd+K omnisearch. A floating button (mirrors NotificationsBell,
 * opposite corner) opens a centered modal; results are grouped by entity type
 * and each group's label reuses the sidebar's nav.* strings — one source of
 * truth for what a "customer"/"contract"/etc. is called in each locale.
 */
// Aliased: an unqualified `KeyboardEvent` import would shadow the DOM type
// that the document-level Ctrl+K listener below relies on.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { NAV_ITEMS } from '@/lib/nav';
import { Icon } from './icons';

interface Hit {
  type: string;
  id: string;
  labelAr: string;
  labelEn: string;
  sublabel?: string | null;
  href: string;
}
type Results = Record<string, Hit[]>;

/** `commands` is client-side (screens), the rest come from the API. */
const GROUP_ORDER = ['commands', 'customers', 'leads', 'contracts', 'invoices', 'projects', 'workOrders', 'serialUnits'];
const GROUP_NAV_KEY: Record<string, string> = {
  commands: 'search.commands',
  customers: 'nav.customers',
  leads: 'nav.leads',
  contracts: 'nav.contracts',
  invoices: 'nav.invoices',
  projects: 'nav.projects',
  workOrders: 'nav.workorders',
  serialUnits: 'nav.assets',
};
const GROUP_ICON: Record<string, string> = {
  commands: 'search',
  customers: 'users',
  leads: 'target',
  contracts: 'file-signature',
  invoices: 'receipt',
  projects: 'building',
  workOrders: 'wrench',
  serialUnits: 'scan',
};

export function GlobalSearch() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const router = useRouter();
  const ar = locale === 'ar';
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Results>({});
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    setResults({});
    setActive(0);
  }, []);

  /**
   * Screens the caller can open, matched by their translated label — this is
   * the "type a function name and go there" half of the search. Purely
   * client-side: the nav map is already in the bundle, so it costs no request
   * and answers before the debounced API call returns.
   */
  const commandHits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    return NAV_ITEMS.filter((i) => !i.perm || can(i.perm))
      .filter((i) => t(i.key).toLowerCase().includes(needle))
      .map<Hit>((i) => ({
        type: 'commands',
        id: `cmd:${i.href}`,
        labelAr: t(i.key),
        labelEn: t(i.key),
        sublabel: i.href,
        href: i.href,
      }));
  }, [q, can, t]);

  // Ctrl+K / Cmd+K opens from anywhere; Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === 'Escape' && open) {
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  // Debounced fetch.
  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setResults({});
      return;
    }
    setLoading(true);
    const h = setTimeout(() => {
      api
        .get<Results>(`/search?q=${encodeURIComponent(q.trim())}`)
        .then(setResults)
        .catch(() => setResults({}))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(h);
  }, [open, q]);

  function onPick(hit: Hit) {
    close();
    router.push(hit.href);
  }

  /** ↑/↓ walk the flat result list, Enter opens the highlighted row. */
  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (totalHits === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % totalHits);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + totalHits) % totalHits);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = flat[active];
      if (hit) onPick(hit);
    }
  }

  const groups = GROUP_ORDER.map(
    (g) => [g, g === 'commands' ? commandHits : results[g] ?? []] as const,
  ).filter(([, rows]) => rows.length > 0);
  // Flat, in display order — what the arrow keys walk over.
  const flat = groups.flatMap(([, rows]) => rows);
  const totalHits = flat.length;

  return (
    <>
      {/* Desktop only, and offset from the notification bell's end-8 corner
          (not the sidebar's start side) — the mobile top bar has no room for
          a second floating button next to the hamburger; Ctrl+K still works
          on any screen regardless. */}
      <div className="no-print fixed end-24 top-3 z-50 hidden lg:block">
        <button
          aria-label={t('search.open')}
          onClick={() => setOpen(true)}
          className="flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 text-slate-500 shadow-card transition hover:text-brand-600"
        >
          <Icon name="search" className="h-[16px] w-[16px]" />
          <span className="hidden text-xs font-medium sm:inline">{t('search.open')}</span>
          <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 md:inline">
            Ctrl K
          </kbd>
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center bg-ink-950/50 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card-hover">
            <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3">
              <Icon name="search" className="h-4 w-4 shrink-0 text-slate-400" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onInputKeyDown}
                placeholder={t('search.placeholder')}
                className="flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-slate-400"
              />
              <button className="text-[11px] text-slate-400 hover:text-slate-600" onClick={close}>
                {t('search.close')}
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto [scrollbar-width:thin]">
              {q.trim().length < 2 ? (
                <p className="px-4 py-8 text-center text-xs text-slate-400">{t('search.hint')}</p>
              ) : loading && totalHits === 0 ? (
                <div className="space-y-3 px-4 py-5" aria-hidden>
                  <div className="skeleton h-3 w-2/3" />
                  <div className="skeleton h-3 w-1/2" />
                  <div className="skeleton h-3 w-3/5" />
                </div>
              ) : totalHits === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-slate-400">{t('search.noResults')}</p>
              ) : (
                groups.map(([type, rows]) => (
                  <div key={type} className="py-2">
                    <p className="px-4 pb-1 text-[11px] font-bold text-slate-400">{t(GROUP_NAV_KEY[type])}</p>
                    {rows.map((hit) => {
                      const idx = flat.indexOf(hit);
                      return (
                      <button
                        key={hit.id}
                        data-active={idx === active || undefined}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => onPick(hit)}
                        className={`flex w-full items-center gap-3 px-4 py-2 text-start transition ${
                          idx === active ? 'bg-brand-50' : 'hover:bg-slate-50'
                        }`}
                      >
                        <Icon name={GROUP_ICON[type]} className="h-4 w-4 shrink-0 text-slate-400" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-800">
                            {ar ? hit.labelAr : hit.labelEn}
                          </span>
                          {hit.sublabel && (
                            <span className="block truncate text-[11px] text-slate-400">{hit.sublabel}</span>
                          )}
                        </span>
                      </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
