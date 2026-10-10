// Builds a link to NPI's own web app (apps/web) — used for anything that
// leaves the copilot entirely (the home tiles, the "back to NPI" links).
//
// Base resolution order:
//   1. `NEXT_PUBLIC_NPI_WEB_URL`, when it is a non-empty string — set in
//      production/staging so the two apps can be split across origins.
//   2. `http://localhost:3000` outside production — apps/web's own dev
//      server port, so local development links somewhere real without
//      requiring the env var to be set.
//   3. `''` in production with no env var — same-origin behind the reverse
//      proxy, so a relative path still resolves correctly.
const DEV_FALLBACK_BASE = 'http://localhost:3000';

function resolveBase(): string {
  const envUrl = process.env.NEXT_PUBLIC_NPI_WEB_URL;
  if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl;
  if (process.env.NODE_ENV !== 'production') return DEV_FALLBACK_BASE;
  return '';
}

/** Builds an absolute (or origin-relative) URL on NPI's web app. `path` must
 *  start with `/` (e.g. `/inbox`). A trailing slash on the resolved base is
 *  stripped so the result never carries a doubled slash. */
export function npiWebUrl(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`npiWebUrl: path must start with "/", got ${JSON.stringify(path)}`);
  }
  const base = resolveBase().replace(/\/+$/, '');
  return `${base}${path}`;
}
