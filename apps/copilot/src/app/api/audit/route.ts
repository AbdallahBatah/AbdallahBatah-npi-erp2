// /trust screen endpoint (T-33 part A, F-17, spec/madar/01 §5 «الثقة»).
//   GET /copilot/api/audit              -> AuditListView (newest first, keyset pagination)
//   GET /copilot/api/audit?id=          -> { row: AuditDetailView } or 404 (never 403: the id must not confirm existence)
//
// Read only — there is no POST: the copilot never deletes or edits its trust
// log. Administrator only (`admin.user.manage`, the same guard as
// `api/settings/route.ts`), checked here and again by the reader. Same
// skeleton as `api/settings/route.ts` and `api/handover/route.ts`: session
// handling, error -> status mapping, `Cache-Control: no-store`. Every read
// lives in `src/audit/query.ts`; this file only validates the query string and
// maps outcomes to HTTP.
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { AuditError, TRUST_PERMISSION, getAuditRow, listAudit, type AuditCaller } from '@/audit/query';
import { AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE_MAX, type AuditDetailResponse, type AuditFilters } from '@/audit/types';
import { t } from '@/i18n/ar';
import { createNpiClient } from '@/npi/client';
import { NpiError } from '@/npi/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** An id the route will even look up: what Prisma's cuid/uuid ids look like
 *  (the same pattern `api/handover/route.ts` uses). */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 64;
const MAX_CURSOR_LENGTH = 128;

const IdSchema = z.string().min(1).max(MAX_ID_LENGTH).regex(ID_PATTERN);

const ListQuerySchema = z.object({
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX))
    .optional(),
  event: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .optional(),
  imageSent: z.enum(['true', 'false']).optional(),
  userId: IdSchema.optional(),
});

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

async function sessionOrNull() {
  try {
    return { session: await getServerSession(), npiDown: false };
  } catch (err) {
    if (err instanceof NpiError) return { session: null, npiDown: true };
    throw err;
  }
}

function notFound(): NextResponse {
  return json({ error: 'not_found', messageAr: t('trust.not_found') }, 404);
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuditError) {
    if (err.code === 'bad_cursor') return json({ error: 'bad_request' }, 400);
    return json({ error: err.code, messageAr: err.messageAr }, err.status);
  }
  if (err instanceof ZodError) return json({ error: 'bad_request' }, 400);
  if (err instanceof NpiError) {
    if (err.kind === 'unauthorized') return json({ error: 'unauthenticated' }, 401);
    return json({ error: 'npi_error', messageAr: err.messageAr }, 502);
  }
  console.error('[copilot] audit GET failed', err instanceof Error ? err.message : err);
  return json({ error: 'server', messageAr: t('state.error') }, 500);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { session, npiDown } = await sessionOrNull();
  if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
  if (!session) return json({ error: 'unauthenticated' }, 401);
  if (!session.user.permissions.includes(TRUST_PERMISSION)) {
    return json({ error: 'forbidden', messageAr: t('trust.forbidden') }, 403);
  }

  const caller: AuditCaller = {
    npiOrgId: session.user.npiOrgId,
    npiUserId: session.user.npiUserId,
    permissions: session.user.permissions,
  };
  const params = request.nextUrl.searchParams;

  try {
    // The trust log is read through `getDb()` directly: the real client
    // satisfies `AuditQueryDb` without a cast (checked in tests/audit-db.spec.ts).
    const deps = { db: getDb(), npi: createNpiClient({ token: session.npiToken }) };

    const id = params.get('id');
    if (id !== null) {
      if (!IdSchema.safeParse(id).success) return notFound();
      const row = await getAuditRow(deps, caller, id);
      if (!row) return notFound();
      const body: AuditDetailResponse = { row };
      return json(body, 200);
    }

    const query = ListQuerySchema.parse(Object.fromEntries(params));
    const filters: AuditFilters = {};
    if (query.event !== undefined) filters.event = query.event;
    if (query.imageSent !== undefined) filters.imageSent = query.imageSent === 'true';
    if (query.userId !== undefined) filters.npiUserId = query.userId;

    const view = await listAudit(deps, caller, {
      filters,
      cursor: query.cursor ?? null,
      limit: query.limit ?? AUDIT_PAGE_SIZE,
    });
    return json(view, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
