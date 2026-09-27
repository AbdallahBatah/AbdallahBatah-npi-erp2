'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { translateError } from '@/lib/errors';
import { Btn, Field } from '@/components/ui';
import { Icon } from '@/components/icons';

export default function LoginPage() {
  const { login } = useAuth();
  const { t, toggle, locale } = useI18n();
  const router = useRouter();
  // Demo-credential prefill is opt-in via a build-time flag: production
  // builds must start with empty fields. NEXT_PUBLIC_* vars are inlined at
  // build time, so this check is static (no runtime env lookup happens).
  const demoPrefill = process.env.NEXT_PUBLIC_DEMO_PREFILL === '1';
  const [email, setEmail] = useState(demoPrefill ? 'admin@npi.sa' : '');
  const [password, setPassword] = useState(demoPrefill ? 'Admin@123' : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Redirected here by the 401 interceptor → tell the user why.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('expired')) {
      setError(t('login.expired'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      router.push('/dashboard');
    } catch (err) {
      // Wrong credentials vs. server/network problems are different messages.
      if (err instanceof ApiError && err.status === 401) setError(t('login.error'));
      else setError(translateError(err, locale));
    } finally {
      setBusy(false);
    }
  }

  const highlights =
    locale === 'ar'
      ? ['فوترة ZATCA المرحلة الثانية', 'من العميل المحتمل إلى العقد إلى الأصل', 'مراقبة المحطات وتسوية PPA']
      : ['ZATCA Phase-2 e-invoicing', 'Lead → contract → asset, one spine', 'Plant monitoring & PPA settlement'];

  return (
    <div className="flex min-h-screen bg-ink-950">
      {/* Brand panel */}
      <div className="relative hidden flex-1 items-center justify-center overflow-hidden lg:flex">
        {/* Brand artwork (Canva, NPI palette) under a darkening veil so the
            white wordmark and highlights always stay readable on top. */}
        <img
          src="/brand/login-bg.webp"
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-ink-950/45" />
        {/* faint grid */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              'linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
        <div className="relative z-10 max-w-md px-10">
          <img src="/brand/npi-logo-on-dark.svg" alt="NPI" className="mb-8 h-20 w-auto" />

          <h1 className="text-3xl font-bold leading-tight text-white">{t('app.name')}</h1>
          {/* On the dark hero, slate-400 is the higher-contrast choice (7.5:1);
              slate-500 belongs on the light surfaces only. */}
          <p className="mt-3 text-sm leading-relaxed text-slate-400">{t('app.tagline')}</p>
          <ul className="mt-10 space-y-4">
            {highlights.map((h) => (
              <li key={h} className="flex items-center gap-3 text-sm text-slate-400">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-300">
                  <Icon name="check" className="h-3.5 w-3.5" />
                </span>
                {h}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex w-full items-center justify-center bg-[#f4f6f8] p-6 lg:w-[480px] lg:shrink-0">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center justify-between lg:hidden">
            <div className="flex items-center gap-2">
              <img src="/brand/npi-icon.svg" alt="" className="h-9 w-9" />
              <span className="font-bold text-slate-900">{t('app.name')}</span>
            </div>
          </div>

          <div className="mb-8 flex items-start justify-between">
            <div>
              <h2 className="text-3xl font-bold text-slate-900">{t('login.title')}</h2>
              <p className="mt-1 text-xs text-slate-600">{t('app.tagline')}</p>
            </div>
            <button
              onClick={toggle}
              aria-label={locale === 'ar' ? 'Switch to English' : 'التبديل إلى العربية'}
              className="btn-ghost btn-sm"
            >
              {locale === 'ar' ? 'EN' : 'ع'}
            </button>
          </div>

          <form onSubmit={onSubmit} className="space-y-5">
            <Field label={t('login.email')}>
              <input
                className="input !py-2.5"
                type="email"
                name="email"
                autoComplete="email"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Field label={t('login.password')}>
              <input
                className="input !py-2.5"
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            {error && (
              <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">
                {error}
              </p>
            )}
            <Btn type="submit" variant="primary" className="w-full !py-2.5" busy={busy}>
              {t('login.submit')}
            </Btn>
          </form>

          <p className="mt-6 text-center text-xs text-slate-600">{t('login.hint')}</p>
        </div>
      </div>
    </div>
  );
}
