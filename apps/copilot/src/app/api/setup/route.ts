// Onboarding setup endpoint (F-14, spec/madar/02 §7).
//   GET  /copilot/api/setup  -> the caller's current step + its defaults
//   POST /copilot/api/setup  { action: 'answer' | 'goto' | 'preview' | 'apply', ... }
//
// Admin only: the session user must hold the NPI permission
// `admin.user.manage` (the same permission `admin configuration` writes in
// `src/npi/client.ts` need) — anyone else gets 403 before any onboarding
// code runs. The orchestration itself lives in `src/onboarding/service.ts`,
// kept thin here the same way `api/chat/route.ts` keeps `runTurn` thin.
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { t } from '@/i18n/ar';
import { createLlmClient } from '@/llm/client';
import { createAnthropicProvider } from '@/llm/providers/anthropic';
import { createNpiClient } from '@/npi/client';
import { NpiError } from '@/npi/errors';
import { buildSetupReadDeps } from '@/onboarding/deps';
import { MachineError } from '@/onboarding/machine';
import { PlanError } from '@/onboarding/plan';
import { getSetupState, handleSetupAction, SetupForbiddenError, type SetupDeps } from '@/onboarding/service';
import { buildDictionary } from '@/privacy/dictionary';
import { Pseudonymizer } from '@/privacy/pseudonymizer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
/** apps/api/src/modules/admin/admin.controller.ts (`@Post('roles')` /
 *  `@Patch('roles/:id')`) — the same guard T-16's plan treats as the
 *  "configure NPI" permission (`STEP_WRITE_PERMISSION.role` in `gaps.ts`). */
const SETUP_PERMISSION = 'admin.user.manage';

// One provider per process, same as `src/agents/context.ts`.
const provider = createAnthropicProvider();

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** A browser sends `Origin` on cross-site POSTs; one that names another host
 *  is refused (same check as `api/chat/route.ts`). */
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

async function buildDeps(npiToken: string, user: { npiOrgId: string; npiUserId: string; nameAr: string }): Promise<SetupDeps> {
  const db = getDb();
  const npi = createNpiClient({ token: npiToken });
  const dictionary = await buildDictionary(npi, {
    npiOrgId: user.npiOrgId,
    npiUserId: user.npiUserId,
    nameAr: user.nameAr,
  });
  return {
    // Prisma's generated `OnboardingSession.update` types `stepsJson` as its
    // own strict `InputJsonValue` (an object type with a string index
    // signature our own `SetupState`/`unknown` shapes don't structurally
    // carry), the same friction `src/agents/run.ts` works around with
    // `memoryNoteJson: ... as never` at its own write site. The real client
    // accepts any JSON-serializable value at runtime; only the compile-time
    // shape disagrees, so the whole client is handed to `SetupDeps.db` with
    // one cast here rather than re-typing every JSON column it owns.
    db: db as unknown as SetupDeps['db'],
    npi,
    llm: createLlmClient({ provider, db }),
    pseudonymizer: new Pseudonymizer(dictionary),
  };
}

function npiErrorStatus(err: NpiError): number {
  return err.kind === 'unauthorized' ? 401 : 502;
}

export async function GET(): Promise<NextResponse> {
  const { session, npiDown } = await sessionOrNull();
  if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
  if (!session) return json({ error: 'unauthenticated' }, 401);
  if (!session.user.permissions.includes(SETUP_PERMISSION)) {
    return json({ error: 'forbidden', messageAr: t('setup.forbidden') }, 403);
  }

  try {
    // A read needs no model and no dictionary (T-39b): the same deps the
    // setup page builds for its server render.
    const deps = buildSetupReadDeps(session.npiToken);
    const view = await getSetupState(deps, {
      npiOrgId: session.user.npiOrgId,
      npiUserId: session.user.npiUserId,
      roleKey: session.user.roleKey,
      permissions: session.user.permissions,
    });
    return json(view, 200);
  } catch (err) {
    if (err instanceof SetupForbiddenError) return json({ error: 'forbidden', messageAr: err.messageAr }, err.status);
    if (err instanceof NpiError) return json({ error: 'npi_error', messageAr: err.messageAr }, npiErrorStatus(err));
    console.error('[copilot] setup GET failed', err instanceof Error ? err.message : err);
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
  if (!session.user.permissions.includes(SETUP_PERMISSION)) {
    return json({ error: 'forbidden', messageAr: t('setup.forbidden') }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  try {
    const deps = await buildDeps(session.npiToken, session.user);
    const result = await handleSetupAction(
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
    if (err instanceof MachineError) {
      return json({ error: 'invalid_answer', messageAr: t('setup.invalid_answer', { detail: err.message }), issues: err.issues }, 400);
    }
    if (err instanceof PlanError) {
      return json({ error: 'invalid_plan', messageAr: t('setup.invalid_answer', { detail: err.message }), issues: err.issues }, 400);
    }
    if (err instanceof NpiError) {
      return json({ error: 'npi_error', messageAr: err.messageAr }, npiErrorStatus(err));
    }
    if (err instanceof ZodError) {
      return json({ error: 'bad_request' }, 400);
    }
    console.error('[copilot] setup POST failed', err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}
