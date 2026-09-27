// Edge-safe gate: checks cookie PRESENCE only. Real validation (decrypt,
// expiry, NPI revalidation) happens server-side in `getServerSession()`
// (src/auth/session.ts), which needs Prisma and therefore cannot run here —
// the only import below is `next/server` plus `./auth/cookie`, which itself
// imports nothing Node-only (see the note at the top of that file).
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from './auth/cookie';

// `/brand` holds NPI's logo files from `public/`: the login page shows them
// to a visitor who has no session yet.
const PUBLIC_PATHS = ['/login', '/api/auth', '/brand'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  // `/login` is always reachable. Whether a visitor who is already signed in
  // should be sent home is decided by the page itself against the real
  // session: a cookie may outlive its session, and redirecting on its mere
  // presence would loop between the login page and the home page.
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (!hasCookie) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'unauthenticated' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Two patterns, not one: with `basePath` set (next.config.js), the
  // exclusion pattern alone does not match the bare basePath root itself
  // (e.g. a request for exactly `/copilot`, with nothing after it) — only
  // paths with at least one more segment. The explicit `/` entry covers
  // that root request; the second pattern covers everything else.
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
