'use client';

/**
 * The notification bell: a floating button (top-end corner, above the mobile
 * top bar) with an unread badge, polling every 30s, and a dropdown feed.
 * Rows carry pre-rendered ar/en text from the server — no key plumbing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Icon } from './icons';

interface NotificationRow {
  id: string;
  type: string;
  titleAr: string;
  titleEn: string;
  bodyAr?: string | null;
  bodyEn?: string | null;
  linkPath?: string | null;
  readAt?: string | null;
  createdAt: string;
}

function timeAgo(iso: string, ar: boolean): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return ar ? 'الآن' : 'now';
  if (mins < 60) return ar ? `قبل ${mins} د` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return ar ? `قبل ${hours} س` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return ar ? `قبل ${days} يوم` : `${days}d ago`;
}

export function NotificationsBell() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ar = locale === 'ar';

  const refreshCount = useCallback(() => {
    api
      .get<{ unreadCount: number }>('/notifications/unread-count')
      .then((r) => setUnread(r.unreadCount))
      .catch(() => undefined); // the bell never surfaces its own errors
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = setInterval(refreshCount, 30_000);
    return () => clearInterval(timer);
  }, [refreshCount]);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        const r = await api.get<{ rows: NotificationRow[]; unreadCount: number }>('/notifications');
        setRows(r.rows);
        setUnread(r.unreadCount);
      } catch {
        /* keep the last list */
      }
    }
  }

  async function onRowClick(n: NotificationRow) {
    setOpen(false);
    if (!n.readAt) {
      setUnread((u) => Math.max(0, u - 1));
      api.post(`/notifications/${n.id}/read`).catch(() => undefined);
    }
    if (n.linkPath) router.push(n.linkPath);
  }

  async function markAll() {
    setRows((r) => r.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setUnread(0);
    api.post('/notifications/read-all').catch(() => undefined);
  }

  return (
    <div ref={wrapRef} className="no-print fixed end-4 top-2 z-50 lg:end-8 lg:top-3">
      <button
        aria-label={t('notif.open')}
        onClick={toggleOpen}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-card transition hover:text-brand-600"
      >
        <Icon name="bell" className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -end-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 mt-2 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card-hover">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <span className="text-sm font-bold text-slate-800">{t('notif.title')}</span>
            {unread > 0 && (
              <button className="text-xs text-brand-600 hover:underline" onClick={markAll}>
                {t('notif.markAll')}
              </button>
            )}
          </div>
          <ul className="max-h-[60vh] divide-y divide-slate-50 overflow-y-auto [scrollbar-width:thin]">
            {rows.length === 0 && (
              <li className="px-4 py-8 text-center text-xs text-slate-400">{t('notif.empty')}</li>
            )}
            {rows.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => onRowClick(n)}
                  className={`flex w-full items-start gap-2.5 px-4 py-3 text-start transition hover:bg-slate-50 ${
                    n.readAt ? '' : 'bg-brand-50/40'
                  }`}
                >
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      n.readAt ? 'bg-transparent' : 'bg-brand-500'
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-xs ${n.readAt ? 'text-slate-600' : 'font-semibold text-slate-800'}`}>
                      {ar ? n.titleAr : n.titleEn}
                    </span>
                    {(ar ? n.bodyAr : n.bodyEn) && (
                      <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                        {ar ? n.bodyAr : n.bodyEn}
                      </span>
                    )}
                    <span className="mt-0.5 block text-[10px] text-slate-300">
                      {timeAgo(n.createdAt, ar)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
