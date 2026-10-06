// Chat endpoint.
//   POST /copilot/api/chat  { text?, conversationId?, documentId?, forcedFlow? }  -> the assistant's reply
//        (`text` may be left out only when `documentId` is given; an entry flow runs
//        its extraction inside this call and the reply carries the `intakeJobId`)
//   GET  /copilot/api/chat[?conversationId=…]          -> a conversation's messages
//                                                          (the user's latest when no id is given)
//
// Both act as the logged-in user and only ever touch that user's own
// conversations. The NPI token stays on the server.
import { NextResponse, type NextRequest } from 'next/server';
import { buildTurn } from '@/agents/context';
import type { FlowType } from '@/agents/router';
import { MAX_MESSAGE_LENGTH, TurnInputError, runTurn } from '@/agents/run';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';
import { FLOW_TYPES } from '@/onboarding/profile.schema';
import { conversationReadableBy } from '@/positions/reassign';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const HISTORY_LIMIT = 50;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** A browser sends `Origin` on cross-site POSTs; one that names another host
 *  is refused. */
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
    // NPI could not confirm the session right now.
    if (err instanceof NpiError) return { session: null, npiDown: true };
    throw err;
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
  const { text, conversationId, documentId, forcedFlow } = (body ?? {}) as {
    text?: unknown;
    conversationId?: unknown;
    documentId?: unknown;
    forcedFlow?: unknown;
  };
  if (documentId !== undefined && (typeof documentId !== 'string' || documentId.length === 0 || documentId.length > 64)) {
    return json({ error: 'bad_request' }, 400);
  }
  if (forcedFlow !== undefined && (typeof forcedFlow !== 'string' || !(FLOW_TYPES as readonly string[]).includes(forcedFlow))) {
    return json({ error: 'bad_request' }, 400);
  }
  // Text may be left out only when a document is attached.
  if (text !== undefined && typeof text !== 'string') return json({ error: 'bad_request' }, 400);
  if (documentId === undefined && (text === undefined || text.trim().length === 0)) return json({ error: 'bad_request' }, 400);
  if (text !== undefined && text.length > MAX_MESSAGE_LENGTH) {
    return json({ error: 'too_long', messageAr: t('chat.error.too_long') }, 413);
  }
  if (conversationId !== undefined && (typeof conversationId !== 'string' || conversationId.length > 64)) {
    return json({ error: 'bad_request' }, 400);
  }

  try {
    const { deps, user } = await buildTurn({ npiToken: session.npiToken, user: session.user });
    const reply = await runTurn(deps, user, {
      text: text ?? '',
      conversationId,
      documentId,
      forcedFlow: forcedFlow as FlowType | undefined,
    });
    return json(reply, 200);
  } catch (err) {
    if (err instanceof TurnInputError) {
      switch (err.reason) {
        case 'conversation_not_found':
          return json({ error: 'not_found' }, 404);
        case 'document_not_found':
          return json({ error: 'not_found', messageAr: t('document.error.not_found') }, 404);
        case 'consent_required':
          return json({ error: 'consent_required', messageAr: t('intake.consent_required') }, 409);
        default:
          return json({ error: 'bad_request' }, 400);
      }
    }
    // Details stay in the server log; the browser gets a fixed message.
    console.error('[copilot] chat turn failed', err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('chat.error.generic') }, 500);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { session, npiDown } = await sessionOrNull();
  if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
  if (!session) return json({ error: 'unauthenticated' }, 401);

  const db = getDb();
  const requested = request.nextUrl.searchParams.get('conversationId');
  const owner = { npiUserId: session.user.npiUserId, npiOrgId: session.user.npiOrgId };

  // A named conversation is the owner's — or, for an administrator, a
  // predecessor's in the position they left (BR-07, T-30 D-T30-5); anyone else
  // gets the same 404 as a conversation that does not exist. Without an id,
  // only the caller's own latest conversation is ever returned.
  const conversation = requested
    ? await conversationReadableBy(
        db,
        { npiOrgId: session.user.npiOrgId, npiUserId: session.user.npiUserId, permissions: session.user.permissions },
        requested,
      )
    : await db.conversation.findFirst({ where: owner, orderBy: { updatedAt: 'desc' }, select: { id: true } });

  if (!conversation) {
    return requested ? json({ error: 'not_found' }, 404) : json({ conversationId: null, messages: [] }, 200);
  }

  const rows = await db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
    select: {
      id: true,
      role: true,
      contentAr: true,
      badge: true,
      kind: true,
      memoryNoteJson: true,
      intakeJobId: true,
      documentId: true,
      createdAt: true,
    },
  });

  return json(
    {
      conversationId: conversation.id,
      messages: rows.reverse().map((row) => ({
        id: row.id,
        role: row.role,
        textAr: row.contentAr,
        ...(row.kind ? { kind: row.kind } : {}),
        badges: row.badge ? row.badge.split('، ') : [],
        memoryNotes: Array.isArray(row.memoryNoteJson) ? row.memoryNoteJson : [],
        ...(row.intakeJobId ? { intakeJobId: row.intakeJobId } : {}),
        ...(row.documentId ? { documentId: row.documentId } : {}),
        createdAt: row.createdAt.toISOString(),
      })),
    },
    200,
  );
}
