'use client';

import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { t, type ArKey } from '@/i18n/ar';
import { Button } from '@/components/ui/Button';

/** basePath (next.config.js) is fixed at build time — hardcoded here rather
 *  than read from a router helper, same as the API route's own fixed path. */
const AUTH_API_PATH = '/copilot/api/auth';
const HOME_PATH = '/copilot';

type ErrorCode = 'invalid' | 'rate_limited' | 'npi_down' | 'required' | 'unknown';

const ERROR_KEY: Record<ErrorCode, ArKey> = {
  invalid: 'login.error.invalid',
  rate_limited: 'login.error.rate_limited',
  npi_down: 'login.error.npi_down',
  // An empty/incomplete submission and a 400 (the server's own validation
  // failure — a malformed body, not a credentials problem) share one
  // message: "NPI is unavailable" would be misleading for either.
  required: 'login.error.required',
  // Falls back to the generic NPI-unreachable message for anything this
  // form was not specifically told about (network failure, unexpected
  // status, malformed response, …).
  unknown: 'login.error.npi_down',
};

function errorCodeFor(status: number, bodyError: unknown): ErrorCode {
  if (bodyError === 'invalid') return 'invalid';
  if (bodyError === 'rate_limited') return 'rate_limited';
  if (bodyError === 'npi_down') return 'npi_down';
  if (status === 400) return 'required';
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

  // Focus moves to the alert once it exists in the DOM — driven by the
  // error's own state change (an effect that runs after render), not by
  // scheduling a microtask from inside the submit handler: a microtask can
  // run before React has committed the DOM node the ref points at.
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    if (email.trim().length === 0 || password.trim().length === 0) {
      setError('required');
      return;
    }

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
    } catch {
      setError('unknown');
      setSubmitting(false);
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
          autoComplete="username"
          inputMode="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError(null);
          }}
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
          }}
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
