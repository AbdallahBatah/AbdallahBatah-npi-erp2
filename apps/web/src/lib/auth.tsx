'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
  useCallback,
} from 'react';
import { api, FORBIDDEN_EVENT, getToken, setToken } from './api';
import { clearAllDrafts } from './useDraft';

export interface AuthUser {
  id: string;
  email: string;
  nameAr: string;
  nameEn: string;
  locale: 'AR' | 'EN';
  roleKey: string;
  roleNameAr?: string;
  roleNameEn?: string;
  /** Every role the user holds, primary first (CRM Phase 1). Optional for older API builds. */
  roles?: Array<{ id: string; key: string; nameAr: string; nameEn: string }>;
  /** Union of the permissions of all the user's roles. */
  permissions: string[];
  organization: { id: string; nameAr: string; nameEn: string; baseCurrency: string };
}

interface AuthValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  can: (permission: string) => boolean;
  /**
   * Re-read the session from the server now (ADR-02 §3-5), e.g. after an
   * administrator saves a role or a user's exceptions. Coalesced with the
   * background refreshes; resolves once the read that covers this call is done.
   */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Background re-read of `/auth/me` while the tab is visible. */
const REFRESH_EVERY_MS = 60_000;
/** Floor between two re-reads, however many triggers fire in between. */
const REFRESH_MIN_GAP_MS = 2_000;

/**
 * What a change of role, permissions or profile can move in the session. A
 * re-read that leaves it unchanged keeps the current `user` object, so a
 * refresh that finds nothing new re-renders nothing.
 */
function sessionSignature(u: AuthUser): string {
  return JSON.stringify([
    u.id,
    [...u.permissions].sort().join(','),
    u.roleKey,
    u.roleNameAr ?? '',
    u.roleNameEn ?? '',
    u.nameAr,
    u.nameEn,
    u.locale,
  ]);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  // Refresh bookkeeping: the read on the wire, the one waiting its turn, and
  // when the last one started. Refs, so none of it re-renders anything.
  const inFlight = useRef<Promise<void> | null>(null);
  const queued = useRef<Promise<void> | null>(null);
  const lastStart = useRef(0);

  useEffect(() => {
    let active = true;
    // No stored token means no session to restore — asking the API anyway
    // just fills the console with guaranteed 401s on the login screen.
    if (!getToken()) {
      setLoading(false);
      return;
    }
    lastStart.current = Date.now();
    void (async () => {
      try {
        const me = await api.get<AuthUser>('/auth/me');
        if (active) setUser(me);
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  /**
   * One re-read of `/auth/me`. A failure — network down, or a session the
   * server no longer accepts — keeps the `user` we have; the next ordinary
   * request deals with an expired session as it always did. Never rejects.
   */
  const readSession = useCallback(() => {
    lastStart.current = Date.now();
    const read = (async () => {
      if (!getToken()) return;
      try {
        const me = await api.get<AuthUser>('/auth/me');
        // Signed out (or the token dropped by a 401 elsewhere) while waiting.
        if (!getToken()) return;
        setUser((prev) =>
          prev && sessionSignature(prev) === sessionSignature(me) ? prev : me,
        );
      } catch {
        /* keep the current session; the next trigger tries again */
      }
    })().finally(() => {
      if (inFlight.current === read) inFlight.current = null;
    });
    inFlight.current = read;
    return read;
  }, []);

  /**
   * Coalesced: never two reads on the wire and never two starts within
   * REFRESH_MIN_GAP_MS. A call that cannot start now joins the one queued read
   * that starts as soon as both allow it, so a trigger is never dropped — a
   * 403 that lands while an older read is in flight still gets a read that
   * began after it.
   */
  const refresh = useCallback((): Promise<void> => {
    if (!getToken()) return Promise.resolve();
    if (queued.current) return queued.current;
    if (!inFlight.current && Date.now() - lastStart.current >= REFRESH_MIN_GAP_MS) {
      return readSession();
    }
    const next = (async () => {
      if (inFlight.current) await inFlight.current;
      const wait = lastStart.current + REFRESH_MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      queued.current = null;
      await readSession();
    })();
    queued.current = next;
    return next;
  }, [readSession]);

  // The live effect of a permission change (ADR-02 §3-5): re-read the session
  // every minute while the tab is visible, when it becomes visible again, and
  // on any 403 (apiFetch announces those), so a withdrawn screen leaves the
  // sidebar and a granted one appears without signing out and in again.
  const signedIn = user !== null;
  useEffect(() => {
    if (!signedIn) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onForbidden = () => void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_EVERY_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(FORBIDDEN_EVENT, onForbidden);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(FORBIDDEN_EVENT, onForbidden);
    };
  }, [signedIn, refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ accessToken: string; user: AuthUser }>('/auth/login', {
      email,
      password,
    });
    setToken(res.accessToken);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    // Unsent drafts are this user's work — never leave them for whoever signs
    // in next on a shared machine.
    clearAllDrafts();
    if (typeof window !== 'undefined') window.location.href = '/login';
  }, []);

  const can = useCallback(
    (permission: string) => !!user?.permissions.includes(permission),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, login, logout, can, refresh }),
    [user, loading, login, logout, can, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
