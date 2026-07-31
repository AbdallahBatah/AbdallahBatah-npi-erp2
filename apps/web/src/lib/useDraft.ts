'use client';

/**
 * Persists an in-progress form to localStorage so a refresh, an accidental
 * back, or a dead laptop battery does not cost the user their work.
 *
 * Scope: unsent input only. Nothing here is authoritative — the moment a form
 * is submitted its draft is cleared, so a draft can never shadow saved data.
 * Drafts are namespaced per key (and per record, via the caller's key) and
 * live under a single `npi_draft:` prefix so they are easy to find and purge.
 *
 * Deliberately NOT used for anything already persisted server-side, and never
 * for credentials — see the callers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const PREFIX = 'npi_draft:';

/** Drop every stored draft — call on logout so one user cannot see another's. */
export function clearAllDrafts() {
  if (typeof window === 'undefined') return;
  for (const k of Object.keys(window.localStorage)) {
    if (k.startsWith(PREFIX)) window.localStorage.removeItem(k);
  }
}

export function useDraft<T>(
  key: string,
  value: T,
  restore: (saved: T) => void,
  options: {
    enabled?: boolean;
    /**
     * Whether the current value is worth keeping. Without this, discarding a
     * draft immediately re-saves the emptied form, and the next visit would
     * announce "restored a draft" over nothing.
     */
    shouldSave?: (value: T) => boolean;
  } = {},
) {
  const enabled = options.enabled ?? true;
  const shouldSave = options.shouldSave;
  const storageKey = PREFIX + key;
  const [restored, setRestored] = useState(false);
  // Restoring writes to the same state we watch; without this the restore
  // would immediately be recorded as a fresh edit.
  const hydrating = useRef(true);

  // Restore once on mount.
  useEffect(() => {
    if (!enabled) return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        restore(JSON.parse(raw) as T);
        setRestored(true);
      }
    } catch {
      window.localStorage.removeItem(storageKey);
    }
    // A microtask is enough: the restore's state update is flushed before the
    // save effect below runs again.
    const id = setTimeout(() => {
      hydrating.current = false;
    }, 0);
    return () => clearTimeout(id);
    // Restore is intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, enabled]);

  // Save on change, debounced — typing should not hit localStorage per key.
  useEffect(() => {
    if (!enabled || hydrating.current) return;
    const h = setTimeout(() => {
      try {
        if (shouldSave && !shouldSave(value)) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, JSON.stringify(value));
      } catch {
        /* quota or private mode — losing a draft must never break the form */
      }
    }, 500);
    return () => clearTimeout(h);
  }, [storageKey, value, enabled, shouldSave]);

  const clear = useCallback(() => {
    window.localStorage.removeItem(storageKey);
    setRestored(false);
  }, [storageKey]);

  return { restored, clear };
}
