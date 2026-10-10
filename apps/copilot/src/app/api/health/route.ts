// Health probe for the container (apps/copilot/Dockerfile HEALTHCHECK, the
// `copilot` service's healthcheck in docker-compose.prod.yml, and the rolling
// deploy's wait — T-40). Public (src/middleware.ts), unauthenticated and
// deliberately uninformative: 200 `{ ok: true }` when the copilot's own
// database answers a trivial query, 503 `{ ok: false }` otherwise. The same
// reasoning as NPI's /api/health: a bare TCP connect cannot tell a wedged
// process (dead pool, unreachable database) from a healthy one. Nothing from
// the environment or from the error reaches the response.
import { NextResponse } from 'next/server';
import { getDb } from '@/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(): Promise<NextResponse> {
  try {
    await getDb().$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: NO_STORE });
  }
}
