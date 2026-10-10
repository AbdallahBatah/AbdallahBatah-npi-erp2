'use client';

import { useRef, type KeyboardEvent } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import type { ProfileKey } from '@/onboarding/profile.schema';

export interface ProfileCardProps {
  profiles: { key: ProfileKey; titleAr: string }[];
  selectedKey: ProfileKey | null;
  onSelectKey: (key: ProfileKey) => void;
  /** True once the administrator already answered step 1 before — picking a
   *  *different* profile now clears steps 2–6 on the server. */
  showChangeWarning: boolean;
}

/**
 * Step 1's editor (`03` §2 `ProfileCard`): six selectable cards, one per
 * line-of-business pack, as an ARIA `radiogroup`. Arrow keys move the
 * selection (the native "radio" pattern — moving is choosing, same as a
 * real `<input type="radio">` group); Space/Enter on a focused card selects
 * it too, for free, since these are real `<button>` elements.
 */
export function ProfileCard({ profiles, selectedKey, onSelectKey, showChangeWarning }: ProfileCardProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function moveSelection(delta: 1 | -1) {
    const index = profiles.findIndex((p) => p.key === selectedKey);
    const from = index === -1 ? 0 : index;
    const next = profiles[(from + delta + profiles.length) % profiles.length];
    onSelectKey(next.key);
    refs.current[next.key]?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      moveSelection(-1);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label={t('setup.profile.pick')} className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        {profiles.map((profile) => {
          const selected = profile.key === selectedKey;
          return (
            <button
              key={profile.key}
              ref={(el) => {
                refs.current[profile.key] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (selectedKey === null && profile.key === profiles[0]?.key) ? 0 : -1}
              onKeyDown={handleKeyDown}
              onClick={() => onSelectKey(profile.key)}
              className={[
                'flex min-h-11 items-center rounded-xl border-2 p-4 text-start text-sm font-semibold transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                selected ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-800 hover:border-slate-300',
              ].join(' ')}
            >
              {t(`profile.${profile.key}` as ArKey)}
            </button>
          );
        })}
      </div>
      {showChangeWarning ? (
        <p className="text-sm text-warning-700">{t('setup.profile.change_warning')}</p>
      ) : null}
    </div>
  );
}
