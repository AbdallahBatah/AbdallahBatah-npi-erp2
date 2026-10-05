// Logout endpoint: `POST /copilot/api/auth/logout` destroys the server-side
// session and clears the cookie. The browser's logout button calls this
// (`src/components/ShellFrame.tsx`). A POST, not a DELETE, on purpose
// (D-16): the copilot issues no DELETE request anywhere — not to NPI and not
// to itself — so `tests/invariants.spec.ts` can forbid the verb outright.
// Node runtime (not edge): it needs Prisma (via getDb()) and the AEAD key.
export const runtime = 'nodejs';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { destroySession } from '@/auth/session';
import { clearedSessionCookieAttributes, SESSION_COOKIE_NAME } from '@/auth/cookie';
import { buildDeps, json, NO_STORE_HEADERS, originMismatch } from '../shared';

export async function POST(): Promise<NextResponse> {
  if (originMismatch()) return json({ error: 'forbidden' }, 403);

  const deps = buildDeps();
  const cookieValue = cookies().get(SESSION_COOKIE_NAME)?.value;
  await destroySession(deps, cookieValue);

  cookies().set(SESSION_COOKIE_NAME, '', clearedSessionCookieAttributes());

  return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
}
