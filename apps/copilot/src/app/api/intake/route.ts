// Intake-job endpoint (T-26, spec/madar/02 §5.7-5.8).
//   GET  /copilot/api/intake?id=<jobId>   -> { job: IntakeView }
//   POST /copilot/api/intake  IntakeAction -> { job: IntakeView }
//        confirm | set | choose | edit | approve | cancel
//
// Acts as the logged-in user and only ever touches that user's own jobs (a
// job of someone else answers 404). Same route conventions as
// api/documents/route.ts: `json()` with no-store, `crossSite()`,
// `sessionOrNull()`, 503 when NPI cannot confirm the session, 401 without
// one, details in the server log and a fixed Arabic message in the response.
// Nothing here writes to NPI: «approve» records the decision (T-27 executes).
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { buildEditDeps } from '@/agents/context';
import { getServerSession } from '@/auth/session';
import { t } from '@/i18n/ar';
import { applyIntakeAction, IntakeEditFailed, IntakeStateError } from '@/intake/edit';
import { getIntakeView } from '@/intake/job';
import type { IntakeAction } from '@/intake/types';
import { NpiError } from '@/npi/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_ID_LENGTH = 64;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Same check as api/chat/route.ts / api/documents/route.ts. */
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

const id = z.string().min(1).max(MAX_ID_LENGTH);
/** A dotted path into the assessed tree: «customer.nameAr», «lines.0.qty». */
const path = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z]+(\.[A-Za-z0-9]+)*$/);

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ id, action: z.literal('confirm'), path }),
  z.object({ id, action: z.literal('set'), path, value: z.string().max(4000) }),
  z.object({ id, action: z.literal('choose'), target: z.string().min(1).max(MAX_ID_LENGTH), choice: z.string().min(1).max(MAX_ID_LENGTH) }),
  z.object({ id, action: z.literal('edit'), text: z.string().trim().min(1).max(4000) }),
  z.object({ id, action: z.literal('approve') }),
  z.object({ id, action: z.literal('cancel') }),
]);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { session, npiDown } = await sessionOrNull();
  if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
  if (!session) return json({ error: 'unauthenticated' }, 401);

  const jobId = request.nextUrl.searchParams.get('id');
  if (!jobId || jobId.length > MAX_ID_LENGTH) return json({ error: 'bad_request' }, 400);

  try {
    const deps = buildEditDeps({ npiToken: session.npiToken, user: session.user });
    const job = await getIntakeView(deps, { npiOrgId: session.user.npiOrgId, npiUserId: session.user.npiUserId }, jobId);
    if (job === null) return json({ error: 'not_found', messageAr: t('intake.not_found') }, 404);
    return json({ job }, 200);
  } catch (err) {
    console.error('[copilot] intake fetch failed', err instanceof Error ? err.message : err);
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'bad_request' }, 400);
  const action: IntakeAction = parsed.data;

  try {
    const deps = buildEditDeps({ npiToken: session.npiToken, user: session.user });
    const job = await applyIntakeAction(deps, { npiOrgId: session.user.npiOrgId, npiUserId: session.user.npiUserId }, action);
    return json({ job }, 200);
  } catch (err) {
    if (err instanceof IntakeStateError) {
      switch (err.reason) {
        case 'not_found':
          return json({ error: 'not_found', messageAr: t('intake.not_found') }, 404);
        case 'state':
          return json({ error: 'state', messageAr: t('intake.state_conflict') }, 409);
        default:
          return json({ error: err.reason }, 400);
      }
    }
    if (err instanceof IntakeEditFailed) return json({ error: 'edit_failed', messageAr: err.messageAr }, 422);
    if (err instanceof NpiError) return json({ error: 'npi', messageAr: err.messageAr }, 502);
    console.error('[copilot] intake action failed', action.action, err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}
