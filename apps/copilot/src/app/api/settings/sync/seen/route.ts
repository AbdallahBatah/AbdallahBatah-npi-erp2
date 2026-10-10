// POST /copilot/api/settings/sync/seen — the home banner's «تم» (T-47b).
//
// Records that an administrator has looked at the last NPI change
// (`firm_config.lastSyncSeenAt`). Gate: `admin.department.manage`, like the
// banner itself. No request body; nothing is read from or sent to NPI.
import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';
import { markSyncSeen, SyncForbiddenError, type SyncSeenDb } from '@/settings/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Same check as `../../route.ts`. */
function crossSite(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get('host');
  } catch {
    return true;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (crossSite(request)) return json({ error: 'forbidden' }, 403);

  let session;
  try {
    session = await getServerSession();
  } catch (err) {
    if (err instanceof NpiError) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
    throw err;
  }
  if (!session) return json({ error: 'unauthenticated' }, 401);

  try {
    await markSyncSeen(
      { db: getDb() as unknown as SyncSeenDb },
      {
        npiOrgId: session.user.npiOrgId,
        npiUserId: session.user.npiUserId,
        roleKey: session.user.roleKey,
        permissions: session.user.permissions,
      },
    );
    return json({ ok: true }, 200);
  } catch (err) {
    if (err instanceof SyncForbiddenError) return json({ error: 'forbidden', messageAr: err.messageAr }, 403);
    console.error('[copilot] settings sync seen failed', err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}
