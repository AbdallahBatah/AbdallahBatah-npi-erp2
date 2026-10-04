// /settings screen endpoint (T-19, spec/madar/02 §5.9 and §7).
//   GET  /copilot/api/settings  -> the firm's config, positions, baselines
//   POST /copilot/api/settings  { action: 'visible_modules' | 'baseline' | 'rerun', ... }
//
// Admin only, same guard as `api/setup/route.ts` (`admin.user.manage`), and
// the same structure: crossSite check, content-type check, session
// handling, error -> status mapping, `Cache-Control: no-store`. The
// orchestration itself lives in `src/settings/service.ts`.
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { t } from '@/i18n/ar';
import { createNpiClient } from '@/npi/client';
import { NpiError } from '@/npi/errors';
import { SetupForbiddenError } from '@/onboarding/service';
import { getSettingsView, handleSettingsAction, SettingsError, type SettingsDb, type SettingsDeps } from '@/settings/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
/** apps/api/src/modules/admin/admin.controller.ts (`@Post('roles')` /
 *  `@Patch('roles/:id')`) — the same guard `api/setup/route.ts` enforces. */
const SETTINGS_PERMISSION = 'admin.user.manage';

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Same check as `api/setup/route.ts`/`api/chat/route.ts`. */
function crossSite(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get('host');
  } catch {
    return true;
  }
}

async function sessionOrNull() {
  try {
    return { session: await getServerSession(), npiDown: false };
  } catch (err) {
    if (err instanceof NpiError) return { session: null, npiDown: true };
    throw err;
  }
}

function buildDeps(npiToken: string): SettingsDeps {
  const db = getDb();
  return {
    // Prisma's generated client types `firmConfig`/`position`/`manualBaseline`
    // more strictly than the structural `SettingsDb` this file (and
    // `src/settings/service.ts`) is written against — the same friction
    // `api/setup/route.ts` works around with its own `db` cast.
    db: db as unknown as SettingsDb,
    npi: createNpiClient({ token: npiToken }),
  };
}

function npiErrorStatus(err: NpiError): number {
  return err.kind === 'unauthorized' ? 401 : 502;
}

export async function GET(): Promise<NextResponse> {
  const { session, npiDown } = await sessionOrNull();
  if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
  if (!session) return json({ error: 'unauthenticated' }, 401);
  if (!session.user.permissions.includes(SETTINGS_PERMISSION)) {
    return json({ error: 'forbidden', messageAr: t('settings.forbidden') }, 403);
  }

  try {
    const deps = buildDeps(session.npiToken);
    const view = await getSettingsView(deps, {
      npiOrgId: session.user.npiOrgId,
      npiUserId: session.user.npiUserId,
      roleKey: session.user.roleKey,
      permissions: session.user.permissions,
    });
    return json(view, 200);
  } catch (err) {
    if (err instanceof SetupForbiddenError) return json({ error: 'forbidden', messageAr: err.messageAr }, err.status);
    if (err instanceof NpiError) return json({ error: 'npi_error', messageAr: err.messageAr }, npiErrorStatus(err));
    console.error('[copilot] settings GET failed', err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (crossSite(request)) return json({ error: 'forbidden' }, 403);
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json({ error: 'unsupported_media_type' }, 415);
  }

  const { session, npiDown } = await sessionOrNull();
  if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
  if (!session) return json({ error: 'unauthenticated' }, 401);
  if (!session.user.permissions.includes(SETTINGS_PERMISSION)) {
    return json({ error: 'forbidden', messageAr: t('settings.forbidden') }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  try {
    const deps = buildDeps(session.npiToken);
    const result = await handleSettingsAction(
      deps,
      {
        npiOrgId: session.user.npiOrgId,
        npiUserId: session.user.npiUserId,
        roleKey: session.user.roleKey,
        permissions: session.user.permissions,
      },
      body,
    );
    return json(result, 200);
  } catch (err) {
    if (err instanceof SetupForbiddenError) return json({ error: 'forbidden', messageAr: err.messageAr }, err.status);
    if (err instanceof SettingsError) {
      const status = err.code === 'no_config' ? 409 : 400;
      return json({ error: err.code === 'no_config' ? 'no_config' : 'invalid', messageAr: err.messageAr }, status);
    }
    if (err instanceof NpiError) {
      return json({ error: 'npi_error', messageAr: err.messageAr }, npiErrorStatus(err));
    }
    if (err instanceof ZodError) {
      return json({ error: 'bad_request' }, 400);
    }
    console.error('[copilot] settings POST failed', err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}
