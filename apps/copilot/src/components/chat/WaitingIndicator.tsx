import { t } from '@/i18n/ar';

/** The three dots have no identity beyond their position (which also sets the
 *  stagger delay), so they get constant ids rather than the array index. */
const DOTS = ['first', 'second', 'third'] as const;

/** Shown while a sent turn is in flight. `<output>` (implicit
 *  `status` role) so assistive tech announces it once; the three dots pulse
 *  only under `motion-safe` (T-12's visual rules require
 *  `prefers-reduced-motion` to be respected).
 *
 *  `label` (T-22) lets a caller reuse this same indicator for a different
 *  in-flight action (e.g. `Chat.tsx` passes `t('chat.attaching')` while a
 *  document uploads) — the default stays `t('chat.waiting')` so every
 *  existing call site is unaffected. */
export function WaitingIndicator({ label }: { label?: string } = {}) {
  return (
    <output
      className="flex w-fit items-center gap-1 rounded-2xl bg-slate-100 px-4 py-2.5 text-sm text-slate-600"
    >
      <span>{label ?? t('chat.waiting')}</span>
      <span className="flex items-center gap-0.5" aria-hidden="true">
        {DOTS.map((dot, i) => (
          <span
            key={dot}
            className="h-1.5 w-1.5 rounded-full bg-slate-400 motion-safe:animate-bounce motion-reduce:animate-none"
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </span>
    </output>
  );
}
