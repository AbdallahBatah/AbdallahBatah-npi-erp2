import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { Chat } from '@/components/chat/Chat';
import { HomeTilesGrid, HomeTilesSkeleton } from '@/components/HomeTiles';
import { ShellFrame } from '@/components/ShellFrame';
import { getServerSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { createNpiClient } from '@/npi/client';
import { NpiError } from '@/npi/errors';

export const dynamic = 'force-dynamic';

/**
 * The home screen (T-08): greeting, the four NPI tiles, and the chat panel
 * (T-12) — per spec/madar/03-DESIGN-SPEC.md §3's "Home+Chat" row.
 *
 * The tiles are read on the server, inside a `<Suspense>` boundary, so a slow
 * NPI response never blocks the chat from rendering; `Chat` itself fetches
 * its own conversation client-side. The NPI token is only ever handed to
 * `createNpiClient` here, on the server — it never reaches a client
 * component or the rendered HTML.
 */
export default async function HomePage() {
  let session;
  try {
    session = await getServerSession();
  } catch (err) {
    if (!(err instanceof NpiError)) throw err;
    // Shell-less on purpose: the shell shows the user's name and a logout
    // button, and neither is known if NPI itself could not be reached.
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

  const npi = createNpiClient({ token: session.npiToken });

  return (
    <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
      <div className="flex flex-col gap-5">
        <h1 className="text-lg font-bold text-slate-900">
          {t('home.greeting', { name: session.user.nameAr })}
        </h1>
        <Suspense fallback={<HomeTilesSkeleton />}>
          <HomeTilesGrid npi={npi} />
        </Suspense>
        <Chat userName={session.user.nameAr} />
      </div>
    </ShellFrame>
  );
}
