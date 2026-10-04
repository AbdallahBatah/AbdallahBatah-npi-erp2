// Document intake endpoint (T-21, spec/madar/02 §5.1-5.2).
//   POST /copilot/api/documents  multipart/form-data { file }  -> the stored document (or a refusal)
//   GET  /copilot/api/documents?id=<id>                        -> that document's summary
//
// Same route conventions as api/chat/route.ts and api/settings/route.ts:
// `json()` helper with Cache-Control: no-store, `crossSite()`, `sessionOrNull()`,
// 503 on npiDown, 401 unauthenticated, error -> status mapping,
// `console.error('[copilot] …')` with no secrets. The orchestration itself
// lives in `src/intake/upload.ts`.
import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { t } from '@/i18n/ar';
import {
  createFsStorage,
  docsRoot,
  MAX_UPLOAD_BYTES,
  summarizeDocument,
  uploadDocument,
  type IntakeDb,
} from '@/intake/upload';
import { NpiError } from '@/npi/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_ID_LENGTH = 64;
/** Room for the multipart boundary, part headers and the file name. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Same check as api/chat/route.ts / api/settings/route.ts. */
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

function storage() {
  return createFsStorage(docsRoot());
}

function refusalResponse(reason: Extract<Awaited<ReturnType<typeof uploadDocument>>, { status: 'refused' }>['reason']): NextResponse {
  switch (reason) {
    case 'empty':
      return json({ error: 'empty', messageAr: t('document.error.empty') }, 400);
    case 'too_large':
      return json({ error: 'too_large', messageAr: t('document.error.too_large') }, 413);
    case 'unsupported_type':
      return json({ error: 'unsupported_type', messageAr: t('document.error.unsupported') }, 415);
    case 'confidential':
      return json({ error: 'refused_confidential', messageAr: t('intake.refused_confidential') }, 422);
    case 'pdf_encrypted':
      return json({ error: 'pdf_encrypted', messageAr: t('document.error.encrypted') }, 422);
    case 'pdf_invalid':
    case 'heic_failed':
      return json({ error: 'unreadable', messageAr: t('document.error.unreadable') }, 422);
    default:
      return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (crossSite(request)) return json({ error: 'forbidden' }, 403);
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
    return json({ error: 'unsupported_media_type' }, 415);
  }

  const { session, npiDown } = await sessionOrNull();
  if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
  if (!session) return json({ error: 'unauthenticated' }, 401);

  // The body is only parsed (and so only held in memory) when the declared
  // length can fit the cap plus multipart framing; the exact check on the
  // file itself follows once the form is parsed.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return json({ error: 'too_large', messageAr: t('document.error.too_large') }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    return json({ error: 'bad_request' }, 400);
  }
  const blob = file as File | Blob;
  if (blob.size > MAX_UPLOAD_BYTES) {
    return json({ error: 'too_large', messageAr: t('document.error.too_large') }, 413);
  }
  const fileName = blob instanceof File ? blob.name : 'document';

  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const db: IntakeDb = getDb();
    const outcome = await uploadDocument(
      { db, storage: storage() },
      { npiOrgId: session.user.npiOrgId, npiUserId: session.user.npiUserId },
      { fileName, bytes },
    );

    if (outcome.status === 'created') return json({ document: outcome.document }, 201);
    if (outcome.status === 'existing') return json({ document: outcome.document, deduplicated: true }, 200);
    return refusalResponse(outcome.reason);
  } catch (err) {
    console.error('[copilot] document upload failed', err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { session, npiDown } = await sessionOrNull();
  if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
  if (!session) return json({ error: 'unauthenticated' }, 401);

  const id = request.nextUrl.searchParams.get('id');
  if (!id || id.length > MAX_ID_LENGTH) return json({ error: 'bad_request' }, 400);

  try {
    const db: IntakeDb = getDb();
    const row = await db.document.findFirst({
      where: { id, npiOrgId: session.user.npiOrgId, npiUserId: session.user.npiUserId },
    });
    if (!row) return json({ error: 'not_found' }, 404);

    const document = await summarizeDocument(storage(), row);
    return json({ document }, 200);
  } catch (err) {
    console.error('[copilot] document fetch failed', err instanceof Error ? err.message : err);
    return json({ error: 'server', messageAr: t('state.error') }, 500);
  }
}
