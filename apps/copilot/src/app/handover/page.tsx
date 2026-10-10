import { redirect } from 'next/navigation';
import { HandoverPanel, type HandoverMode } from '@/components/handover/HandoverPanel';
import { ShellFrame } from '@/components/ShellFrame';
import { getServerSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';

export const dynamic = 'force-dynamic';

/** Same key `/settings` and `/api/handover` guard with (`src/positions/
 *  handover-types.ts` `HANDOVER_ADMIN_PERMISSION`), kept local so this server
 *  component does not pull the reassignment service (db/npi wiring) in for one
 *  string — the same choice `src/app/settings/page.tsx` makes. */
const HANDOVER_ADMIN_PERMISSION = 'admin.user.manage';

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The handover screen (T-30, F-13, spec/madar/01 §3 scenario 5): a single
 * client-driven panel against `/copilot/api/handover`. Every signed-in user
 * may hold a document (as successor or predecessor), so there is no permission
 * gate here — the endpoint answers 404 for a document that is not theirs.
 * `?id=` shows one document, `?positionId=` the reassignment form (a
 * non-administrator gets the list instead, never a page that reveals ids),
 * neither the list. NPI unreachable shows the shell-less error card and no
 * session redirects to `/login`, as on every other screen.
 */
export default async function HandoverPage({ searchParams }: { searchParams: SearchParams }) {
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

  const isAdmin = session.user.permissions.includes(HANDOVER_ADMIN_PERMISSION);
  const id = first(searchParams.id);
  const positionId = first(searchParams.positionId);

  let mode: HandoverMode = { kind: 'list' };
  if (id !== null) mode = { kind: 'doc', id };
  else if (positionId !== null && isAdmin) mode = { kind: 'reassign', positionId };

  return (
    <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
      <div className="flex flex-col gap-5">
        <h1 className="text-lg font-bold text-slate-900">{t('handover.title')}</h1>
        <HandoverPanel mode={mode} isAdmin={isAdmin} />
      </div>
    </ShellFrame>
  );
}
