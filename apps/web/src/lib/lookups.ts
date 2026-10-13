'use client';

/**
 * The pick lists of ADR-02 §3-3 (GET /reference/lookups/<kind>): one request
 * per list, made only for a user who holds one of the list's keys
 * (LOOKUP_ACCESS in @npi/shared), so a page never fires a request it knows
 * will be refused and never shares a Promise.all with one.
 *
 * `state`:
 *  - 'loading'     — the session is still being restored, or the request is in flight
 *                    (or not yet made, while `enabled` is false);
 *  - 'ready'       — `rows` holds the list;
 *  - 'unavailable' — the user holds none of the keys, or the request failed. Any failure
 *                    counts, not only a 403: the page's own data reports network and server
 *                    errors through its usual error card, and a list is never worth a second
 *                    one — the field that needs it is disabled with `lookup.unavailable`.
 *
 * Not cached across pages: a list must show the item or vendor added a minute ago.
 */
import { useEffect, useState } from 'react';
import { canUseLookup, type LookupKind } from '@npi/shared';
import { api } from './api';
import { useAuth } from './auth';

export type LookupState = 'loading' | 'ready' | 'unavailable';

export interface Lookup<T> {
  rows: T[];
  state: LookupState;
}

const LOADING: Lookup<never> = { rows: [], state: 'loading' };
const UNAVAILABLE: Lookup<never> = { rows: [], state: 'unavailable' };

/**
 * `enabled: false` defers the request (e.g. until the dialog that needs the list
 * opens). Rows already fetched stay while it is false; turning it back on asks
 * again, so a reopened dialog sees a fresh list.
 */
export function useLookup<T>(kind: LookupKind, opts: { enabled?: boolean } = {}): Lookup<T> {
  const enabled = opts.enabled ?? true;
  const { user } = useAuth();
  const allowed = user ? canUseLookup(kind, user.permissions) : null;
  const [result, setResult] = useState<Lookup<T>>(LOADING);

  useEffect(() => {
    if (!allowed || !enabled) return;
    let active = true;
    api
      .get<T[]>(`/reference/lookups/${kind}`)
      .then((rows) => {
        if (active) setResult({ rows, state: 'ready' });
      })
      .catch(() => {
        if (active) setResult(UNAVAILABLE);
      });
    return () => {
      active = false;
    };
  }, [kind, allowed, enabled]);

  if (allowed === null) return LOADING;
  if (!allowed) return UNAVAILABLE;
  return result;
}
