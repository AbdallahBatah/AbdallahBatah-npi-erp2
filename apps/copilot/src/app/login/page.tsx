import { redirect } from 'next/navigation';
import { getServerSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

/**
 * Server component shell: the interactive form is a client component
 * (`LoginForm`) so it can hold field state and call the API route. NPI-like
 * look per spec/madar/03-DESIGN-SPEC.md §3: full-height dark background, a
 * centred white card.
 *
 * Someone with a valid session is sent home. That is decided here, against
 * the real session, and not in the middleware: the middleware only sees
 * whether a cookie exists, and a cookie of an expired session would bounce
 * the browser between this page and the home page forever.
 */
export default async function LoginPage() {
  let signedIn = false;
  try {
    signedIn = (await getServerSession()) !== null;
  } catch {
    // NPI could not confirm the session right now; show the form.
  }
  if (signedIn) redirect('/');

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-card sm:p-8">
        <h1 className="text-center text-3xl font-bold text-slate-900">{t('app.name')}</h1>
        <p className="mt-2 text-center text-sm text-slate-600">{t('login.subtitle')}</p>
        <div className="mt-8">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
