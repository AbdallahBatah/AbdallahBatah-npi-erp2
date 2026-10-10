// The server's guess at the viewport for the first paint (T-39b, D-23) — a
// plain module, importable from server components (`src/app/layout.tsx`);
// the client side of the hint (the context the components read) lives in
// `src/components/ViewportHint.tsx`. A function exported from a `'use client'`
// module would reach a server component as a client reference, not a
// function, and fail at render time.

/** Phone browsers carry the `Mobile` token in their user agent (Chrome and
 *  Safari on Android and iOS alike); tablets and desktops do not. */
export function desktopHintFromUserAgent(userAgent: string | null): boolean {
  return !/\bMobile\b/.test(userAgent ?? '');
}
