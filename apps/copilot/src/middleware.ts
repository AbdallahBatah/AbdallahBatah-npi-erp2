// Edge-safe gate: checks cookie PRESENCE only. Real validation (decrypt,
// expiry, NPI revalidation) happens server-side in `getServerSession()`
// (src/auth/session.ts), which needs Prisma and therefore cannot run here —
// the only import below is `next/server` plus `./auth/cookie`, which itself
// imports nothing Node-only (see the note at the top of that file).
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from './auth/cookie';
import { generateNonce, securityHeaders } from './security/headers';

// `/brand` holds NPI's logo files from `public/`: the login page shows them
// to a visitor who has no session yet. `/api/health` is the container's
// probe (T-40): Docker and the rolling deploy call it without a session.
const PUBLIC_PATHS = ['/login', '/api/auth', '/api/health', '/brand'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Hands the nonce and the policy to the page render: Next 14 reads the nonce from the request's own `content-security-policy` header to tag the scripts it emits. */
function passThrough(request: NextRequest, nonce: string, csp: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export function middleware(request: NextRequest): NextResponse {
  // Security headers (T-44) go on every response this middleware returns,
  // including the 401 and the redirect: a refusal is a response too.
  const nonce = generateNonce();
  const options = {
    nonce,
    isDev: process.env.NODE_ENV !== 'production',
    // Caddy terminates TLS and tells us so; a direct https request counts too.
    isHttps: request.headers.get('x-forwarded-proto') === 'https' || request.nextUrl.protocol === 'https:',
  };
  const headers = securityHeaders(options);
  const withSecurityHeaders = (response: NextResponse): NextResponse => {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };

  const { pathname } = request.nextUrl;
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  // `/login` is always reachable. Whether a visitor who is already signed in
  // should be sent home is decided by the page itself against the real
  // session: a cookie may outlive its session, and redirecting on its mere
  // presence would loop between the login page and the home page.
  if (isPublicPath(pathname)) {
    return withSecurityHeaders(passThrough(request, nonce, headers['Content-Security-Policy']));
  }

  if (!hasCookie) {
    if (pathname.startsWith('/api/')) {
      return withSecurityHeaders(
        NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: { 'Cache-Control': 'no-store' } }),
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return withSecurityHeaders(NextResponse.redirect(url));
  }

  return withSecurityHeaders(passThrough(request, nonce, headers['Content-Security-Policy']));
}

export const config = {
  // Two patterns, not one: with `basePath` set (next.config.js), the
  // exclusion pattern alone does not match the bare basePath root itself
  // (e.g. a request for exactly `/copilot`, with nothing after it) — only
  // paths with at least one more segment. The explicit `/` entry covers
  // that root request; the second pattern covers everything else.
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
