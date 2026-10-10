import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { Card } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/States';
import { ShellFrame } from '@/components/ShellFrame';
import { getServerSession, type ActiveSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';
import { buildSettingsDeps } from '@/settings/deps';
import { getSettingsView } from '@/settings/service';

export const dynamic = 'force-dynamic';

// The permission constant stays local, as in `src/app/setup/page.tsx`: the page
// checks it before any read, so a caller without it gets the notice below and
// never a `SetupForbiddenError` from the service. (Since T-39b, D-23 this file
// does import `settings/service.ts` — on purpose, to read the same view the
// route's GET returns — which it deliberately did not before.) Same permission
// the settings route itself guards with (`src/app/api/settings/route.ts`,
// `src/settings/service.ts`).
const SETTINGS_ADMIN_PERMISSION = 'admin.user.manage';

/**
 * The settings panel with its first data (T-39b, D-23): the same
 * `getSettingsView` the route's GET calls, with the same deps, read here on
 * the server as an async server component inside a `<Suspense>` boundary — the
 * shell streams first and the panel's HTML follows, instead of the view being
 * fetched after hydration. When the read fails the panel renders without
 * `initialData` and loads itself, showing its own error state with a retry.
 * The session is a prop of this server component only.
 */
async function SettingsWithData({ session }: { session: ActiveSession }) {
  let initialData;
  try {
    // The route's own deps builder (`src/settings/deps.ts`), so page and GET
    // can never read with different wiring.
    initialData = await getSettingsView(buildSettingsDeps(session.npiToken), {
      npiOrgId: session.user.npiOrgId,
      npiUserId: session.user.npiUserId,
      roleKey: session.user.roleKey,
      permissions: session.user.permissions,
    });
  } catch (err) {
    console.error('[copilot] first data for settings failed', err instanceof Error ? err.message : err);
  }
  return <SettingsPanel initialData={initialData} />;
}

/**
 * The settings screen (T-19, F-15, spec/madar/02 §5.9 and §7
 * "re-runnable per step from /settings"): a single panel against
 * `/copilot/api/settings`, handed its first view by this page (T-39b). Same
 * session/permission handling as `src/app/setup/page.tsx` — NPI unreachable
 * shows the shell-less error card, no session redirects to `/login`, and a
 * caller without NPI's `admin.user.manage` permission sees a forbidden
 * notice inside the shell rather than a 404 (every signed-in user could
 * otherwise reach `/settings`).
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
        <Suspense fallback={<LoadingState />}>
          <SettingsWithData session={session} />
        </Suspense>
      </div>
    </ShellFrame>
  );
}
