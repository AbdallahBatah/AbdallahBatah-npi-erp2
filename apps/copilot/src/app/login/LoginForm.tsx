'use client';

import { FormEvent, useId, useRef, useState } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { Button } from '@/components/ui/Button';

/** basePath (next.config.js) is fixed at build time — hardcoded here rather
 *  than read from a router helper, same as the API route's own fixed path. */
const AUTH_API_PATH = '/copilot/api/auth';
const HOME_PATH = '/copilot';

type ErrorCode = 'invalid' | 'rate_limited' | 'npi_down' | 'unknown';

const ERROR_KEY: Record<ErrorCode, ArKey> = {
  invalid: 'login.error.invalid',
  rate_limited: 'login.error.rate_limited',
  npi_down: 'login.error.npi_down',
  // Falls back to the generic NPI-unreachable message for anything this
  // form was not specifically told about (network failure, unexpected
  // status, malformed response, …).
  unknown: 'login.error.npi_down',
};

function errorCodeFor(status: number, bodyError: unknown): ErrorCode {
  if (bodyError === 'invalid') return 'invalid';
  if (bodyError === 'rate_limited') return 'rate_limited';
  if (bodyError === 'npi_down') return 'npi_down';
  if (status === 401) return 'invalid';
  if (status === 429) return 'rate_limited';
  return 'unknown';
}

export function LoginForm() {
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(AUTH_API_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        window.location.assign(HOME_PATH);
        return; // keep the button disabled through the navigation
      }

      let bodyError: unknown;
      try {
        const data = (await res.json()) as { error?: unknown };
        bodyError = data.error;
      } catch {
        bodyError = undefined;
      }
      setError(errorCodeFor(res.status, bodyError));
      setSubmitting(false);
      // Focus moves to the alert region once it exists in the DOM.
      queueMicrotask(() => alertRef.current?.focus());
    } catch {
      setError('unknown');
      setSubmitting(false);
      queueMicrotask(() => alertRef.current?.focus());
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor={emailId} className="mb-1.5 block text-sm font-medium text-slate-700">
          {t('login.email')}
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          dir="ltr"
          autoComplete="username"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="block h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        />
      </div>

      <div>
        <label htmlFor={passwordId} className="mb-1.5 block text-sm font-medium text-slate-700">
          {t('login.password')}
        </label>
        <input
          id={passwordId}
          name="password"
          type="password"
          dir="ltr"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="block h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        />
      </div>

      {error ? (
        <p
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700 focus-visible:outline-none"
        >
          {t(ERROR_KEY[error])}
        </p>
      ) : null}

      <Button type="submit" variant="primary" loading={submitting} className="w-full">
        {submitting ? t('login.submitting') : t('login.submit')}
      </Button>
    </form>
  );
}
