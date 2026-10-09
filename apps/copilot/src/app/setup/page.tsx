import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { SetupWizard } from '@/components/setup/SetupWizard';
import { Card } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/States';
import { ShellFrame } from '@/components/ShellFrame';
import { getServerSession, type ActiveSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';
import { buildSetupReadDeps } from '@/onboarding/deps';
import { getSetupState, previewSetupState, type SetupPreviewResult, type SetupStateView } from '@/onboarding/service';

export const dynamic = 'force-dynamic';

/** Same permission the setup route itself guards with (`src/app/api/setup/
 *  route.ts`'s `SETUP_PERMISSION`, `src/onboarding/service.ts`'s
 *  `SETUP_ADMIN_PERMISSION`): the page checks it before any read, so a
 *  caller without it gets the notice below and never a
 *  `SetupForbiddenError` from the service. */
const SETUP_ADMIN_PERMISSION = 'admin.user.manage';

/**
 * The setup wizard with its first data (T-39b, D-23): the same
 * `getSetupState` the route's GET calls, read here on the server as an async
 * server component inside a `<Suspense>` boundary — the shell streams first
 * and the wizard's HTML follows, instead of the step being fetched after
 * hydration. Only `SetupReadDeps` are built: the route additionally builds
 * the pseudonymizer's dictionary (an NPI call) and a model client, which
 * `getSetupState` never uses, so the page skips both (and
 * `tests/no-bypass-llm.spec.ts` R4d's allowlist of provider-constructing files
 * stays as it is). When the read fails the wizard renders without
 * `initialData` and loads itself, showing its own error state with a retry.
 * The session is a prop of this server component only.
 */
async function SetupWithData({ session }: { session: ActiveSession }) {
  let initialData: SetupStateView | undefined;
  let initialPreview: SetupPreviewResult | null = null;
  try {
    // The route GET's own deps builder (`src/onboarding/deps.ts`), so page
    // and GET can never read with different wiring.
    const deps = buildSetupReadDeps(session.npiToken);
    const caller = {
      npiOrgId: session.user.npiOrgId,
      npiUserId: session.user.npiUserId,
      roleKey: session.user.roleKey,
      permissions: session.user.permissions,
    };
    initialData = await getSetupState(deps, caller);
    // Step 7 shows a live dry run; fetched after hydration it was the
    // screen's largest element at 3.4 s on a phone. Its own failure only
    // costs the head start: the wizard then fetches it as before.
    if (initialData.state.step === 7) {
      try {
        initialPreview = await previewSetupState(deps, caller);
      } catch (err) {
        console.error('[copilot] first data for the setup preview failed', err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error('[copilot] first data for setup failed', err instanceof Error ? err.message : err);
  }
  return <SetupWizard initialData={initialData} initialPreview={initialPreview} />;
}

/**
 * The setup screen (T-18, spec/madar/02 §7): seven steps plus a final diff
 * card, driven by `SetupWizard` against `/copilot/api/setup` (T-17) from the
 * first view this page hands it (T-39b). Same session handling as
 * `src/app/page.tsx`: NPI unreachable shows the shell-less error card, no
 * session redirects to `/login`. Unlike the home page, this screen is
 * admin-only — a caller without NPI's `admin.user.manage` permission sees a
 * forbidden notice inside the shell (never a 404, since `/setup` is a real
 * route every signed-in user could otherwise reach). The NPI token itself
 * never reaches this file's JSX; it stays server-side inside
 * `getServerSession`, the deps builder and the route handlers.
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
        <Suspense fallback={<LoadingState />}>
          <SetupWithData session={session} />
        </Suspense>
      </div>
    </ShellFrame>
  );
}
