'use client';

import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';

/** basePath is fixed at build time (next.config.js) — hardcoded the same way
 *  `LoginForm.tsx` and `chat/api.ts` hardcode their own API paths. */
const LOGOUT_API_PATH = '/copilot/api/auth/logout';
const LOGIN_PATH = '/copilot/login';

export interface ShellFrameProps {
  userName: string;
  isAdmin: boolean;
  children: ReactNode;
}

/**
 * The client-side wrapper `AppShell` needs for its logout button: a
 * `POST /copilot/api/auth/logout` (destroys the server-side session), then a
 * full navigation to the login page regardless of how that call went — a
 * session the browser can no longer prove is not one worth staying on.
 * A POST on purpose (D-16): the copilot issues no DELETE request anywhere.
 */
export function ShellFrame({ userName, isAdmin, children }: ShellFrameProps) {
  async function handleLogout() {
    try {
      await fetch(LOGOUT_API_PATH, { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.assign(LOGIN_PATH);
    }
  }

  return (
    <AppShell userName={userName} isAdmin={isAdmin} onLogout={handleLogout}>
      {children}
    </AppShell>
  );
}
