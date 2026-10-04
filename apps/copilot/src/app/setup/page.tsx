import { redirect } from 'next/navigation';
import { SetupWizard } from '@/components/setup/SetupWizard';
import { Card } from '@/components/ui/Card';
import { ShellFrame } from '@/components/ShellFrame';
import { getServerSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';

export const dynamic = 'force-dynamic';

/** Same permission the setup route itself guards with (`src/app/api/setup/
 *  route.ts`'s `SETUP_PERMISSION`, `src/onboarding/service.ts`'s
 *  `SETUP_ADMIN_PERMISSION`) — kept as a local constant here rather than an
 *  import so this server component does not pull in `onboarding/service.ts`
 *  (db/npi/llm wiring) just to read one string. */
const SETUP_ADMIN_PERMISSION = 'admin.user.manage';

/**
 * The setup screen (T-18, spec/madar/02 §7): seven steps plus a final diff
 * card, all driven client-side by `SetupWizard` against `/copilot/api/setup`
 * (T-17). Same session handling as `src/app/page.tsx`: NPI unreachable shows
 * the shell-less error card, no session redirects to `/login`. Unlike the
 * home page, this screen is admin-only — a caller without NPI's
 * `admin.user.manage` permission sees a forbidden notice inside the shell
 * (never a 404, since `/setup` is a real route every signed-in user could
 * otherwise reach). The NPI token itself never reaches this file's JSX; it
 * stays server-side inside `getServerSession`/route handlers.
 */
export default async function SetupPage() {
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

  if (!session.user.permissions.includes(SETUP_ADMIN_PERMISSION)) {
    return (
      <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
        <Card>
          <p className="text-sm text-slate-700">{t('setup.forbidden')}</p>
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
        <h1 className="text-lg font-bold text-slate-900">{t('setup.title')}</h1>
        <SetupWizard />
      </div>
    </ShellFrame>
  );
}
