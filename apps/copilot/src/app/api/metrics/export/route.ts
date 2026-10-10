// /metrics CSV export (T-35 part B, F-19, spec/madar/02 §8, 07 G-M4-4).
//   GET /copilot/api/metrics/export -> copilot-metrics.csv (BOM + header + six CRLF lines)
//
// Read only, no query parameters, no POST. Administrator only
// (`admin.user.manage`, the same guard as `api/audit/route.ts` and
// `api/settings/route.ts`). Same skeleton as the audit route: session
// handling, error -> status mapping, `Cache-Control: no-store`. Every figure
// is read by `src/metrics/load.ts` over the copilot's own database; this file
// reaches NPI only for the session check.
import { NextResponse } from 'next/server';
import { getServerSession } from '@/auth/session';
import { getDb } from '@/db';
import { metricsToCsv } from '@/metrics/csv';
import { loadMetrics } from '@/metrics/load';
import { METRICS_CSV_FILENAME, METRICS_PERMISSION } from '@/metrics/types';
import { t } from '@/i18n/ar';
import { NpiError } from '@/npi/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

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

function errorResponse(err: unknown): NextResponse {
  if (err instanceof NpiError && err.kind === 'unauthorized') {
    return json({ error: 'unauthenticated' }, 401);
  }
  console.error('[copilot] metrics export failed', err instanceof Error ? err.message : err);
  return json({ error: 'server', messageAr: t('state.error') }, 500);
}

export async function GET(): Promise<NextResponse> {
  try {
    const { session, npiDown } = await sessionOrNull();
    if (npiDown) return json({ error: 'npi_down', messageAr: t('home.error.npi') }, 503);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    if (!session.user.permissions.includes(METRICS_PERMISSION)) {
      return json({ error: 'forbidden', messageAr: t('metrics.forbidden') }, 403);
    }

    // The real client satisfies `MetricsDb` without a cast (tests/metrics-db.spec.ts).
    const csv = metricsToCsv(await loadMetrics(getDb(), { npiOrgId: session.user.npiOrgId }, new Date()));
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${METRICS_CSV_FILENAME}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
