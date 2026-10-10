// Security response headers (T-44, spec/madar/02 §10). Pure functions with no
// Node-only import, so the Edge middleware can call them on every request.

export interface SecurityHeaderOptions {
  /** Per-request nonce: only scripts carrying it (and what they load) may run. */
  nonce: string;
  /** `next dev`: its runtime needs `eval` and a websocket for hot reload. */
  isDev: boolean;
  /** The request reached us over HTTPS (directly or via the proxy). */
  isHttps: boolean;
}

/** 16 random bytes as base64, from the Web Crypto global (present on the Edge runtime and in Node). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function contentSecurityPolicy({ nonce, isDev }: SecurityHeaderOptions): string {
  const directives = [
    "default-src 'self'",
    // A nonce plus 'strict-dynamic': Next's own bootstrap scripts carry the
    // nonce and may load their chunks; an injected `<script>` has no nonce and
    // does not run. Never 'unsafe-inline' here.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // 'unsafe-inline' for styles only: React `style` props and the inline
    // <style> Next emits cannot carry a nonce. Styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    // blob: for camera/photo previews, data: for logos NPI may send inline.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  return directives.join('; ');
}

export function securityHeaders(o: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': contentSecurityPolicy(o),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Camera and microphone are the app's own (photo capture, voice input).
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  // Only over HTTPS: a browser ignores the header on plain HTTP, and a
  // plain-HTTP demo or local run should not advertise a policy it cannot keep.
  if (o.isHttps) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}
