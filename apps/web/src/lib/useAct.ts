'use client';

import { useCallback, useState } from 'react';
import { useToast } from '@/components/toast';
import { useI18n } from './i18n';
import { translateError } from './errors';

/**
 * Single wrapper for every mutation: serializes actions (no double-submit),
 * shows a success toast, and translates failures into a localized error toast.
 *
 *   const { act, busy } = useAct();
 *   <button disabled={busy()} onClick={() => act('issue', () => api.post(...))}>
 *
 * `busy()` — any action running; `busy('issue')` — that action running.
 * `act` resolves to true on success so callers can close modals / navigate.
 */
export function useAct() {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const toast = useToast();
  const { locale, t } = useI18n();

  const act = useCallback(
    async (
      key: string,
      fn: () => Promise<unknown>,
      opts?: { success?: string | false },
    ): Promise<boolean> => {
      if (busyKey) return false;
      setBusyKey(key);
      try {
        await fn();
        if (opts?.success !== false) toast.success(opts?.success ?? t('common.done'));
        return true;
      } catch (e) {
        toast.error(translateError(e, locale));
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, toast, locale, t],
  );

  const busy = useCallback(
    (key?: string) => (key === undefined ? busyKey !== null : busyKey === key),
    [busyKey],
  );

  return { act, busy };
}
