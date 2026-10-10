// Consent endpoint (T-22, spec/madar/02 §5 item 3, ADR-27).
//   POST /copilot/api/documents/consent  { documentId, decision: 'approved' | 'cancelled' }
//
// Same route conventions as api/documents/route.ts and api/settings/route.ts:
// `json()` helper with Cache-Control: no-store, `crossSite()`, content-type
// check, `sessionOrNull()`, 503 on npiDown, 401 unauthenticated, error ->
// status mapping, `console.error('[copilot] …')` with no secrets. The
// orchestration itself lives in `src/intake/consent.ts`; this route never
// calls a model and never touches `src/llm`.
import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { t } from '@/i18n/ar';
import { recordConsent, type ConsentDb, type ConsentDecision } from '@/intake/consent';
import { NpiError } from '@/npi/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_DOCUMENT_ID_LENGTH = 64;
const DECISIONS: ConsentDecision[] = ['approved', 'cancelled'];

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Same check as api/documents/route.ts / api/settings/route.ts. */
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

function isValidBody(body: unknown): body is { documentId: string; decision: ConsentDecision } {
  if (typeof body !== 'object' || body === null) return false;
  const { documentId, decision } = body as Record<string, unknown>;
  if (typeof documentId !== 'string' || documentId.length < 1 || documentId.length > MAX_DOCUMENT_ID_LENGTH) {
    return false;
  }
  return typeof decision === 'string' && (DECISIONS as string[]).includes(decision);
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
  if (!isValidBody(body)) return json({ error: 'bad_request' }, 400);

  try {
    const db: ConsentDb = getDb();
    const outcome = await recordConsent(
      db,
      { npiOrgId: session.user.npiOrgId, npiUserId: session.user.npiUserId },
      { documentId: body.documentId, decision: body.decision },
    );

    switch (outcome.status) {
      case 'recorded':
        return json(
          {
            consentEventId: outcome.consentEventId,
            documentId: outcome.documentId,
            decision: outcome.decision,
            policyLine: outcome.policyLine,
          },
          200,
        );
      case 'not_found':
        return json({ error: 'not_found', messageAr: t('document.error.not_found') }, 404);
      case 'not_needed':
        return json({ error: 'consent_not_needed', messageAr: t('document.error.consent_not_needed') }, 409);
      case 'confidential':
        return json({ error: 'refused_confidential', messageAr: t('intake.refused_confidential') }, 422);
      default:
        return json({ error: 'server', messageAr: t('state.error') }, 500);
    }
  } catch (err) {
    console.error('[copilot] consent failed', err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}
