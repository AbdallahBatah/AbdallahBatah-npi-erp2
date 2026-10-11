// POST /copilot/api/settings/sync — the «حدّث من NPI» button (T-47b).
//
// Re-reads NPI with the signed-in administrator's own token and reconciles
// Madar's departments, positions and holders with it (`syncFromNpi`, reason
// 'manual': no throttle). Gate: NPI's `admin.department.manage`, the permission
// the reads need. Same structure as `../route.ts`: crossSite check, session
// handling, error -> status mapping, `Cache-Control: no-store`. No request body.
import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';
import { buildSyncActionDeps } from '@/settings/deps';
import { runManualSync, SyncForbiddenError } from '@/settings/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Same check as `../route.ts`. */
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
    const result = await runManualSync(buildSyncActionDeps(session.npiToken), {
      npiOrgId: session.user.npiOrgId,
      npiUserId: session.user.npiUserId,
      roleKey: session.user.roleKey,
      permissions: session.user.permissions,
    });
    return json(result, 200);
  } catch (err) {
    if (err instanceof SyncForbiddenError) return json({ error: 'forbidden', messageAr: err.messageAr }, 403);
    if (err instanceof NpiError) {
      return json({ error: 'npi_error', messageAr: err.messageAr }, err.kind === 'unauthorized' ? 401 : 502);
    }
    console.error('[copilot] settings sync failed', err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}
