import { redirect } from 'next/navigation';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { Card } from '@/components/ui/Card';
import { ShellFrame } from '@/components/ShellFrame';
import { getServerSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';

export const dynamic = 'force-dynamic';

/** Same permission the settings route itself guards with
 *  (`src/app/api/settings/route.ts`, `src/settings/service.ts`) and the one
 *  `src/app/setup/page.tsx` already hardcodes locally for the same reason:
 *  kept as a local constant so this server component does not pull in
 *  `settings/service.ts` (db/npi wiring) just to read one string. */
const SETTINGS_ADMIN_PERMISSION = 'admin.user.manage';

/**
 * The settings screen (T-19, F-15, spec/madar/02 §5.9 and §7
 * "re-runnable per step from /settings"): a single client-driven panel
 * against `/copilot/api/settings`. Same session/permission handling as
 * `src/app/setup/page.tsx` — NPI unreachable shows the shell-less error
 * card, no session redirects to `/login`, and a caller without NPI's
 * `admin.user.manage` permission sees a forbidden notice inside the shell
 * rather than a 404 (every signed-in user could otherwise reach `/settings`).
 */
export default async function SettingsPage() {
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

  if (!session.user.permissions.includes(SETTINGS_ADMIN_PERMISSION)) {
    return (
      <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
        <Card>
          <p className="text-sm text-slate-700">{t('settings.forbidden')}</p>
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
        <h1 className="text-lg font-bold text-slate-900">{t('settings.title')}</h1>
        <SettingsPanel />
      </div>
    </ShellFrame>
  );
}
