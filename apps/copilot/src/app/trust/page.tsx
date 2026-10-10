import { redirect } from 'next/navigation';
import { TrustPanel } from '@/components/trust/TrustPanel';
import { Card } from '@/components/ui/Card';
import { ShellFrame } from '@/components/ShellFrame';
import { getServerSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';

export const dynamic = 'force-dynamic';

/** Same permission the audit route itself guards with
 *  (`src/app/api/audit/route.ts`) and the one `src/app/settings/page.tsx`
 *  hardcodes locally for the same reason: kept as a local constant so this
 *  server component does not pull in server wiring (db/npi) just to read one
 *  string. */
const TRUST_ADMIN_PERMISSION = 'admin.user.manage';

/**
 * The trust screen (T-33, F-17, spec/madar/01 §5 «الثقة»): a single
 * client-driven panel against `/copilot/api/audit`. Same session/permission
 * handling as `src/app/settings/page.tsx` — NPI unreachable shows the
 * shell-less error card, no session redirects to `/login`, and a caller
 * without NPI's `admin.user.manage` permission sees a forbidden notice
 * inside the shell rather than a 404.
 */
export default async function TrustPage() {
  let session;
  try {
    session = await getServerSession();
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f4f6f8] p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-card" role="alert">
          <p className="text-sm text-danger-700">{t('home.error.npi')}</p>
          <a
            href="/copilot"
            className="mt-4 inline-block text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {t('action.retry')}
          </a>
        </div>
      </div>
    );
  }

  if (!session) redirect('/login');

  if (!session.user.permissions.includes(TRUST_ADMIN_PERMISSION)) {
    return (
      <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
        <Card>
          <p className="text-sm text-slate-700">{t('trust.forbidden')}</p>
          <a
            href="/"
            className="mt-3 inline-block text-sm font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {t('nav.home')}
          </a>
        </Card>
      </ShellFrame>
    );
  }

  return (
    <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-bold text-slate-900">{t('trust.title')}</h1>
          <p className="text-sm text-slate-600">{t('trust.subtitle')}</p>
        </div>
        <TrustPanel />
      </div>
    </ShellFrame>
  );
}
