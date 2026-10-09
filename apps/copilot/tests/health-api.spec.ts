// GET /copilot/api/health (T-40) — the container's probe. The database module
// is mocked: the route's whole contract is «200 when the copilot's database
// answers, 503 when it does not», with nothing from the failure in the body.
jest.mock('../src/db', () => ({
  getDb: jest.fn(),
}));

import { getDb } from '../src/db';
import { GET } from '../src/app/api/health/route';

const mockedGetDb = getDb as jest.MockedFunction<typeof getDb>;

function dbAnswering(result: Promise<unknown>) {
  const queryRaw = jest.fn(() => result);
  mockedGetDb.mockReturnValue({ $queryRaw: queryRaw } as unknown as ReturnType<typeof getDb>);
  return queryRaw;
}

afterEach(() => jest.resetAllMocks());

describe('GET /copilot/api/health', () => {
  it('answers 200 { ok: true } with no-store when the database answers', async () => {
    const queryRaw = dbAnswering(Promise.resolve([{ '?column?': 1 }]));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('answers 503 { ok: false } when the query fails, without the error text', async () => {
    dbAnswering(Promise.reject(new Error('connection refused at postgres:5432 (password=secret)')));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: false });
    expect(body).not.toContain('secret');
    expect(body).not.toContain('postgres');
  });

  it('answers 503 when the client itself cannot be built (bad or missing COPILOT_DATABASE_URL)', async () => {
    mockedGetDb.mockImplementation(() => {
      throw new Error('COPILOT_DATABASE_URL is missing or empty.');
    });

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });
});
