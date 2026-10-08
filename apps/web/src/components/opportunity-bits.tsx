'use client';

/**
 * Small pieces shared by the opportunity screens (list, detail, customer tab):
 * the direct / tender badge and the two day-counting helpers. CRM Phase 1 · Step 3.
 */
import { useI18n } from '@/lib/i18n';

/** «مناقصة» in the accent colour so a tender stands out in a list; «مباشرة» stays quiet. */
export function OppTypeBadge({ type }: { type: string }) {
  const { t } = useI18n();
  const tender = type === 'TENDER';
  return (
    <span className={`badge ${tender ? 'bg-solar-100 text-solar-700' : 'bg-slate-100 text-slate-600'}`}>
      {t(`opps.type.${type === 'TENDER' ? 'TENDER' : 'DIRECT'}`)}
    </span>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since an ISO timestamp (never negative). */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

/**
 * Whole days from today until an ISO date (negative once it has passed). Both
 * sides are reduced to the calendar day first, so a deadline "today" is 0.
 */
export function daysUntil(iso: string | null | undefined, now = new Date()): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / DAY_MS);
}
