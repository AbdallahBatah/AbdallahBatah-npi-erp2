import { notFound, redirect } from 'next/navigation';
import { IntakePanel } from '@/components/intake/IntakePanel';
import { ShellFrame } from '@/components/ShellFrame';
import { getServerSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';

export const dynamic = 'force-dynamic';

const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The page of one intake job (T-26, F-10; spec/madar/03 §3 «Document»): the
 * preview card and, after approval, the execution card, driven client-side by
 * `IntakePanel` against `/copilot/api/intake`. `[id]` is `intake_jobs.id`
 * (D-T26-1). Same session handling as `src/app/settings/page.tsx`: NPI
 * unreachable shows the shell-less error card, no session redirects to
 * `/login`. Ownership is enforced by the API — a job that is not the
 * caller's answers 404 and the panel shows `intake.not_found`.
 */
export default async function DocumentPage({ params }: { params: { id: string } }) {
  const { id } = params;
  if (id.length === 0 || id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id)) notFound();

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

  return (
    <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
      <div className="flex flex-col gap-5">
        <h1 className="text-lg font-bold text-slate-900">{t('intake.page_title')}</h1>
        <IntakePanel id={id} />
      </div>
    </ShellFrame>
  );
}
