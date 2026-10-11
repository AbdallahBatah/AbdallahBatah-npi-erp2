'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
  useCallback,
} from 'react';
import { api, getToken, setToken } from './api';
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
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    // No stored token means no session to restore — asking the API anyway
    // just fills the console with guaranteed 401s on the login screen.
    if (!getToken()) {
      setLoading(false);
      return;
    }
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

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
