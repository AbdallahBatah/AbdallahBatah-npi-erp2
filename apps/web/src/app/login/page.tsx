'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { translateError } from '@/lib/errors';

export default function LoginPage() {
  const { login } = useAuth();
  const { t, toggle, locale } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState('admin@npi.sa');
  const [password, setPassword] = useState('Admin@123');
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
        {/* glow orbs */}
        <div className="absolute -top-32 start-1/4 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="absolute -bottom-24 end-1/4 h-80 w-80 rounded-full bg-solar-500/10 blur-3xl" />
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
          <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-2xl shadow-glow">
            ☀️
          </div>
          <h1 className="text-3xl font-bold leading-tight text-white">{t('app.name')}</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">{t('app.tagline')}</p>
          <ul className="mt-10 space-y-4">
            {highlights.map((h) => (
              <li key={h} className="flex items-center gap-3 text-sm text-slate-300">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500/15 text-xs text-brand-300">
                  ✓
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
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-base">
                ☀️
              </span>
              <span className="font-bold text-slate-900">{t('app.name')}</span>
            </div>
          </div>

          <div className="mb-8 flex items-start justify-between">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">{t('login.title')}</h2>
              <p className="mt-1 text-xs text-slate-400">{t('app.tagline')}</p>
            </div>
            <button onClick={toggle} className="btn-ghost !px-3 !py-1.5 text-xs">
              {locale === 'ar' ? 'EN' : 'ع'}
            </button>
          </div>

          <form onSubmit={onSubmit} className="space-y-5">
            <div>
              <label className="label">{t('login.email')}</label>
              <input
                className="input !py-2.5"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">{t('login.password')}</label>
              <input
                className="input !py-2.5"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>
            )}
            <button type="submit" className="btn-primary w-full !py-2.5" disabled={busy}>
              {busy ? t('common.loading') : t('login.submit')}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-slate-400">{t('login.hint')}</p>
        </div>
      </div>
    </div>
  );
}
