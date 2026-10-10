// /handover endpoint (T-30, F-13, spec/madar/01 §3 scenario 5, BR-07).
//   GET  /copilot/api/handover                  -> { handovers } the documents this user may read
//   GET  /copilot/api/handover?id=              -> { handover } or 404 (never 403: the id must not confirm existence)
//   GET  /copilot/api/handover?positionId=      -> { candidates } (administrator only)
//   POST /copilot/api/handover { action: 'reassign', positionId, toUserId } -> { outcome }
//   POST /copilot/api/handover { action: 'narrate', id }                    -> { handover }
//
// Same skeleton as `api/settings/route.ts`: crossSite check, content-type
// check, session handling, error -> status mapping, `Cache-Control: no-store`.
// The orchestration and every access rule live in `src/positions/reassign.ts`;
// this file only maps its outcomes to HTTP.
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { buildEditDeps } from '@/agents/context';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { t } from '@/i18n/ar';
import { LlmError, type LlmErrorKind } from '@/llm/client';
import { createNpiClient } from '@/npi/client';
import { NpiError } from '@/npi/errors';
import { Pseudonymizer } from '@/privacy/pseudonymizer';
import type { HandoverCaller } from '@/positions/handover';
import type { HandoverView } from '@/positions/handover-types';
import {
  getHandover,
  HandoverError,
  listCandidates,
  listHandovers,
  narrateHandover,
  reassignPosition,
} from '@/positions/reassign';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** An id the route will even look up: what Prisma's cuid/uuid ids look like. */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 64;

const IdSchema = z.string().min(1).max(MAX_ID_LENGTH).regex(ID_PATTERN);

const ActionBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reassign'), positionId: IdSchema, toUserId: IdSchema }),
  z.object({ action: z.literal('narrate'), id: IdSchema }),
]);

const LLM_ERROR_KINDS: readonly LlmErrorKind[] = [
  'not_configured',
  'cap_reached',
  'timeout',
  'rate_limited',
  'network',
  'provider_down',
  'bad_request',
  'refused',
];

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Same check as `api/settings/route.ts`/`api/chat/route.ts`. */
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

/** The stored `narrative.reason` is a machine kind (an `LlmError` kind,
 *  `bad_output`, `latin_text`); the browser shows Arabic, so the route turns
 *  it into the Arabic sentence before the view leaves the server. The browser
 *  bundle cannot import `@/llm/client` (it pulls server-only modules). */
function narrativeReasonAr(reason: string): string {
  if (reason === 'bad_output') return 'الرد غير مفهوم';
  if (reason === 'latin_text') return 'الرد ليس عربياً';
  if ((LLM_ERROR_KINDS as readonly string[]).includes(reason)) return new LlmError(reason as LlmErrorKind).messageAr;
  return reason;
}

function localizeView(view: HandoverView): HandoverView {
  const narrative = view.body.narrative;
  if (narrative.status !== 'failed') return view;
  return { ...view, body: { ...view.body, narrative: { ...narrative, reason: narrativeReasonAr(narrative.reason) } } };
}

function callerOf(session: NonNullable<Awaited<ReturnType<typeof sessionOrNull>>['session']>): HandoverCaller {
  return {
    npiOrgId: session.user.npiOrgId,
    npiUserId: session.user.npiUserId,
    permissions: session.user.permissions,
  };
}

function notFound(): NextResponse {
  return json({ error: 'not_found', messageAr: t('handover.not_found') }, 404);
}

/** Maps a thrown error to the response the contract names. */
function errorResponse(err: unknown, where: string): NextResponse {
  if (err instanceof HandoverError) return json({ error: err.code, messageAr: err.messageAr }, err.status);
  if (err instanceof ZodError) return json({ error: 'bad_request' }, 400);
  if (err instanceof NpiError) {
    if (err.kind === 'unauthorized') return json({ error: 'unauthenticated' }, 401);
    return json({ error: 'npi_error', messageAr: err.messageAr }, 502);
  }
  console.error(`[copilot] handover ${where} failed`, err instanceof Error ? err.message : err);
  return json({ error: 'server', messageAr: t('state.error') }, 500);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { session, npiDown } = await sessionOrNull();
  if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
  if (!session) return json({ error: 'unauthenticated' }, 401);

  const params = request.nextUrl.searchParams;
  const id = params.get('id');
  const positionId = params.get('positionId');

  try {
    const caller = callerOf(session);

    if (id !== null) {
      if (!IdSchema.safeParse(id).success) return notFound();
      const handover = await getHandover({ db: getDb() }, caller, id);
      if (!handover) return notFound();
      return json({ handover: localizeView(handover) }, 200);
    }

    if (positionId !== null) {
      if (!IdSchema.safeParse(positionId).success) return notFound();
      const candidates = await listCandidates(
        { db: getDb(), npi: createNpiClient({ token: session.npiToken }) },
        caller,
        positionId,
      );
      return json({ candidates }, 200);
    }

    const handovers = await listHandovers({ db: getDb() }, caller);
    return json({ handovers }, 200);
  } catch (err) {
    return errorResponse(err, 'GET');
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

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  try {
    const body = ActionBodySchema.parse(raw);
    const caller = callerOf(session);
    // `edit` carries the audited model client and the dictionary; the database
    // and NPI client are the full ones (`EditDeps` types them more narrowly).
    const edit = buildEditDeps(session);
    const db = getDb();
    const pseudonymizer = async () => new Pseudonymizer(await edit.dictionary());

    if (body.action === 'reassign') {
      const outcome = await reassignPosition(
        { db, npi: createNpiClient({ token: session.npiToken }), llm: edit.llm, pseudonymizer },
        caller,
        { positionId: body.positionId, toUserId: body.toUserId },
      );
      return json({ outcome }, 200);
    }

    const handover = await narrateHandover({ db, llm: edit.llm, pseudonymizer }, caller, body.id);
    return json({ handover: localizeView(handover) }, 200);
  } catch (err) {
    return errorResponse(err, 'POST');
  }
}
