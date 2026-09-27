// Cookie constants and option builders for the copilot session cookie.
//
// No Prisma import here, on purpose: this file is imported by
// `src/middleware.ts`, which runs on Next's Edge runtime and cannot load the
// (Node-only) Prisma client. Everything below is a plain value/option, never
// a decision that requires a database read — that only happens in
// `src/auth/session.ts`, imported by server components and route handlers,
// never by the middleware.
export const SESSION_COOKIE_NAME = 'copilot_session';

/**
 * `basePath` is `/copilot` (see next.config.js) — every page and API route
 * this app serves lives under that path, so the cookie must be scoped there
 * too for the browser to send it back on any of those requests, and not
 * leak to sibling apps sharing the same host.
 */
export const SESSION_COOKIE_PATH = '/copilot';

export interface SessionCookieAttributes {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  expires: Date;
}

/**
 * `secure` is only forced in production so plain http://localhost dev keeps
 * working — a `secure` cookie is silently dropped by the browser over plain
 * HTTP, which would break every local login.
 */
function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Attributes for setting the session cookie after a successful login. */
export function sessionCookieAttributes(expiresAt: Date): SessionCookieAttributes {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(),
    path: SESSION_COOKIE_PATH,
    expires: expiresAt,
  };
}

/** Attributes for clearing the cookie on logout: same scope, already expired. */
export function clearedSessionCookieAttributes(): SessionCookieAttributes {
  return sessionCookieAttributes(new Date(0));
}
