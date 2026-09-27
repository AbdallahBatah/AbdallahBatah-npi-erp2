'use client';

import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';

/** basePath is fixed at build time (next.config.js) — hardcoded the same way
 *  `LoginForm.tsx` and `chat/api.ts` hardcode their own API paths. */
const AUTH_API_PATH = '/copilot/api/auth';
const LOGIN_PATH = '/copilot/login';

export interface ShellFrameProps {
  userName: string;
  isAdmin: boolean;
  children: ReactNode;
}

/**
 * The client-side wrapper `AppShell` needs for its logout button: a
 * `DELETE /copilot/api/auth` (destroys the server-side session), then a full
 * navigation to the login page regardless of how that call went — a session
 * the browser can no longer prove is not one worth staying on.
 */
export function ShellFrame({ userName, isAdmin, children }: ShellFrameProps) {
  async function handleLogout() {
    try {
      await fetch(AUTH_API_PATH, { method: 'DELETE', credentials: 'same-origin' });
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
