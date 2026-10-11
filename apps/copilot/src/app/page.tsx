import { Suspense } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { buildEditDeps } from '@/agents/context';
import { Chat, type ChatFirstData } from '@/components/chat/Chat';
import { HomeTilesGrid, HomeTilesSkeleton } from '@/components/HomeTiles';
import { ShellFrame } from '@/components/ShellFrame';
import { SyncBanner } from '@/components/SyncBanner';
import { getServerSession, type ActiveSession } from '@/auth/session';
import { loadConversationHistory } from '@/chat/history';
import { getDb } from '@/db';
import { t } from '@/i18n/ar';
import { getIntakeView } from '@/intake/job';
import type { IntakeView } from '@/intake/types';
import { createNpiClient } from '@/npi/client';
import { NpiError } from '@/npi/errors';
import { buildSyncBanner } from '@/settings/sync';
import type { SyncBannerView } from '@/settings/types';

export const dynamic = 'force-dynamic';

/**
 * The chat's first data (T-39b, D-23): the caller's latest conversation and
 * the views of the intake cards in it, read here on the server and put in
 * the page's own HTML — not streamed through a `<Suspense>` boundary like the
 * tiles. Fetched after hydration instead, the thread reached a phone on a
 * slow link 2 s past the LCP budget; streamed as a later chunk it was
 * painted at the top of the page and then jumped to its end once hydration
 * ran the scroll (a layout shift of 0.58 on desktop). In the first HTML, the
 * inline script at the end of `Chat` scrolls to the newest message while the
 * document is still being parsed, before anything has been painted. The
 * cost is the read's time on the TTFB (a local database read).
 *
 * The history is the same read `GET /copilot/api/chat` makes
 * (`src/chat/history.ts`) and each card's view the same one
 * `GET /copilot/api/intake` makes, with the same deps (`buildEditDeps`,
 * including the document store that decides a page count) — what `Chat.load`
 * did from the browser. A card whose read threw or found nothing is simply
 * absent and loads itself as before. When the history read itself fails the
 * chat renders without `initialData` and loads from the browser. The NPI
 * token never reaches `Chat`.
 */
async function readChatFirstData(session: ActiveSession): Promise<ChatFirstData | undefined> {
  let initialData: ChatFirstData | undefined;
  try {
    const caller = { npiOrgId: session.user.npiOrgId, npiUserId: session.user.npiUserId };
    const history = await loadConversationHistory(getDb(), { ...caller, permissions: session.user.permissions }, null);
    if (history !== null) {
      const jobIds = [...new Set(history.messages.flatMap((m) => (m.intakeJobId ? [m.intakeJobId] : [])))];
      const intakeViews: Record<string, IntakeView> = {};
      if (jobIds.length > 0) {
        // Built only when a card needs it, and isolated like each read: a
        // failure here costs the cards their head start, never the thread.
        try {
          const intakeDeps = buildEditDeps({ npiToken: session.npiToken, user: session.user });
          await Promise.all(
            jobIds.map(async (id) => {
              try {
                const view = await getIntakeView(intakeDeps, caller, id);
                if (view !== null) intakeViews[id] = view;
              } catch (err) {
                console.error('[copilot] first data for an intake card failed', id, err instanceof Error ? err.message : err);
              }
            }),
          );
        } catch (err) {
          console.error('[copilot] first data for the intake cards failed', err instanceof Error ? err.message : err);
        }
      }
      initialData = { conversationId: history.conversationId, messages: history.messages, intakeViews };
    }
  } catch (err) {
    console.error('[copilot] first data for the chat failed', err instanceof Error ? err.message : err);
  }
  return initialData;
}

/**
 * The unseen NPI change for an administrator (T-47b), read on the server like
 * the chat's first data so the banner is in the first HTML and shifts nothing
 * after hydration. A failed read just means no banner.
 */
async function readSyncBanner(session: ActiveSession): Promise<SyncBannerView | null> {
  try {
    const row = await getDb().firmConfig.findUnique({
      where: { npiOrgId: session.user.npiOrgId },
      select: { lastSyncDiffJson: true, lastSyncSeenAt: true },
    });
    return buildSyncBanner(row, session.user.permissions);
  } catch (err) {
    console.error('[copilot] first data for the sync banner failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The home screen (T-08): greeting, the four NPI tiles, and the chat panel
 * (T-12) — per spec/madar/03-DESIGN-SPEC.md §3's "Home+Chat" row.
 *
 * The tiles are read on the server, inside a `<Suspense>` boundary, so a slow
 * NPI response never blocks the chat from rendering; the chat's history is
 * read on the server too (above), before the HTML is sent, and handed to
 * `Chat`, which keeps its own fetch for a retry. The NPI token is only ever
 * handed to `createNpiClient` here, on the server — it never reaches a
 * client component or the rendered HTML.
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
  const [chatFirstData, syncBanner] = await Promise.all([readChatFirstData(session), readSyncBanner(session)]);
  // Set by the middleware (T-44): the inline scroll script in `Chat` needs it to run under the CSP.
  const scriptNonce = headers().get('x-nonce') ?? undefined;

  return (
    <ShellFrame userName={session.user.nameAr} isAdmin={session.user.isAdmin}>
      <div className="flex flex-col gap-5">
        <h1 className="text-lg font-bold text-slate-900">
          {t('home.greeting', { name: session.user.nameAr })}
        </h1>
        {syncBanner ? <SyncBanner banner={syncBanner} /> : null}
        <Suspense fallback={<HomeTilesSkeleton />}>
          <HomeTilesGrid npi={npi} />
        </Suspense>
        <Chat userName={session.user.nameAr} initialData={chatFirstData} scriptNonce={scriptNonce} />
      </div>
    </ShellFrame>
  );
}
