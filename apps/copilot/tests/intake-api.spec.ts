// Unit tests for src/components/intake/api.ts — the browser-side calls to
// /copilot/api/intake. `fetch` is mocked throughout; no network, no server.
// The bodies are the same views the Playwright spec serves
// (e2e/fixtures/intake.ts), so the runtime guard is checked against exactly
// what the card renders.
import { t } from '../src/i18n/ar';
import { actOnIntake, loadIntake } from '../src/components/intake/api';
import type { IntakeAction } from '../src/intake/types';
import { approvedView, cancelledView, contractView, executedView, executionFailedView, failedView, readyView } from '../e2e/fixtures/intake';

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as Response;
}

function mockFetch(impl: jest.Mock) {
  (global as unknown as { fetch: jest.Mock }).fetch = impl;
}

function respondWith(status: number, body?: unknown) {
  const impl = jest.fn(async (_url: string, _init?: RequestInit) => fakeResponse(status, body));
  mockFetch(impl);
  return impl;
}

afterEach(() => jest.restoreAllMocks());

describe('loadIntake', () => {
  it('returns the job on a normal 200', async () => {
    const view = contractView();
    respondWith(200, { job: view });
    const result = await loadIntake('job-1');
    expect(result).toEqual({ ok: true, job: view });
  });

  it.each([
    ['approved', approvedView()],
    ['executed (a manual step at the end)', executedView()],
    ['stopped at a failed step', executionFailedView()],
    ['cancelled', cancelledView()],
    ['failed (no preview)', failedView()],
    ['ready to approve', readyView()],
  ])('parses a %s job', async (_name, view) => {
    respondWith(200, { job: view });
    const result = await loadIntake('job-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.job.status).toBe(view.status);
  });

  it('an execution with a manual step parses, and the step keeps its state, its entity and its link target', async () => {
    const view = executedView();
    expect(view.execution!.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'manual']);
    respondWith(200, { job: view });
    const result = await loadIntake('job-1');
    expect(result).toEqual({ ok: true, job: view });
    if (result.ok) {
      expect(result.job.status).toBe('done');
      expect(result.job.execution?.status).toBe('done');
      expect(result.job.execution?.steps[3].state).toBe('manual');
      expect(result.job.execution?.steps[1].entity).toEqual({ kindAr: t('exec.kind.contract'), id: 'con-1', code: 'CON-00012', npiPath: '/contracts/con-1' });
    }
  });

  it('a failed execution keeps its failed step, the reason and the step it stopped at', async () => {
    const view = executionFailedView();
    respondWith(200, { job: view });
    const result = await loadIntake('job-1');
    expect(result).toEqual({ ok: true, job: view });
    if (result.ok) {
      expect(result.job.status).toBe('failed');
      expect(result.job.failureAr).toBeNull();
      expect(result.job.preview).not.toBeNull();
      expect(result.job.execution?.failedAt).toBe(2);
      expect(result.job.execution?.steps[1]).toMatchObject({ state: 'failed', errorAr: expect.stringContaining('NPI رفض') });
    }
  });

  it('asks for the id with a GET, same-origin credentials and an Accept header', async () => {
    const impl = respondWith(200, { job: contractView() });
    await loadIntake('job-1');
    const [url, init] = impl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/copilot/api/intake?id=job-1');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    expect(init.body).toBeUndefined();
  });

  it('escapes the id', async () => {
    const impl = respondWith(200, { job: contractView() });
    await loadIntake('a b&c=1');
    expect((impl.mock.calls[0] as [string])[0]).toBe('/copilot/api/intake?id=a%20b%26c%3D1');
  });

  it('maps 404 to not_found with the server’s message, or the default one', async () => {
    respondWith(404, { error: 'not_found', messageAr: 'لم أجد هذه المعاينة.' });
    expect(await loadIntake('job-404')).toEqual({ ok: false, kind: 'not_found', messageAr: 'لم أجد هذه المعاينة.' });

    respondWith(404, { error: 'not_found' });
    expect(await loadIntake('job-404')).toEqual({ ok: false, kind: 'not_found', messageAr: t('intake.not_found') });
  });

  it('maps 401 to unauthenticated', async () => {
    respondWith(401, { error: 'unauthenticated' });
    const result = await loadIntake('job-1');
    expect(result).toMatchObject({ ok: false, kind: 'unauthenticated' });
  });

  it('maps 503 to npi_down and 500 to server', async () => {
    respondWith(503, { error: 'npi_down', messageAr: 'NPI متعطل' });
    expect(await loadIntake('job-1')).toEqual({ ok: false, kind: 'npi_down', messageAr: 'NPI متعطل' });

    respondWith(500, { error: 'server', messageAr: 'ignored' });
    expect(await loadIntake('job-1')).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('reports a network failure', async () => {
    mockFetch(
      jest.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await loadIntake('job-1')).toMatchObject({ ok: false, kind: 'network' });
  });

  it('treats a body that is not JSON as a server error', async () => {
    respondWith(200);
    expect(await loadIntake('job-1')).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  describe('a malformed 200 is a server error, never a half-rendered card', () => {
    const base = () => JSON.parse(JSON.stringify(contractView())) as Record<string, unknown>;
    const mutate = (change: (job: Record<string, any>) => void) => {
      const job = base();
      change(job);
      return { job };
    };

    it.each<[string, unknown]>([
      ['no body job', {}],
      ['a job that is null', { job: null }],
      ['no status', mutate((j) => delete j.status)],
      ['a numeric id', mutate((j) => (j.id = 7))],
      ['no flow label', mutate((j) => delete j.flowLabelAr)],
      ['a preview without sections', mutate((j) => delete j.preview.sections)],
      ['a field with a numeric label', mutate((j) => (j.preview.sections[0].fields[0].labelAr = 5))],
      ['a field with an unknown kind', mutate((j) => (j.preview.sections[0].fields[0].kind = 'blob'))],
      ['a field with no status', mutate((j) => delete j.preview.sections[0].fields[0].status)],
      ['canApprove as a string', mutate((j) => (j.preview.canApprove = 'yes'))],
      ['blockers that are not strings', mutate((j) => (j.preview.blockersAr = [1]))],
      ['a choice without options', mutate((j) => delete j.preview.choices[0].options)],
      ['a document without a name', mutate((j) => delete j.document.fileName)],
      ['an execution step with an unknown state', mutate((j) => (j.execution = { status: 'pending', steps: [{ n: 1, labelAr: 'x', state: 'weird' }] }))],
      ['an execution log whose status is «manual» (that is a step state, not a log status)', mutate((j) => (j.execution = { status: 'manual', steps: [{ n: 1, labelAr: 'x', state: 'manual' }] }))],
      ['an execution log with an unknown status', mutate((j) => (j.execution = { status: 'weird', steps: [] }))],
      ['an execution step with no label', mutate((j) => (j.execution = { status: 'done', steps: [{ n: 1, state: 'done' }] }))],
    ])('%s', async (_name, body) => {
      respondWith(200, body);
      expect(await loadIntake('job-1')).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
    });
  });
});

describe('actOnIntake', () => {
  const ACTIONS: [string, IntakeAction][] = [
    ['confirm', { id: 'job-1', action: 'confirm', path: 'retentionPct' }],
    ['set', { id: 'job-1', action: 'set', path: 'totalValue', value: '900000' }],
    ['choose', { id: 'job-1', action: 'choose', target: 'customer', choice: 'new' }],
    ['edit', { id: 'job-1', action: 'edit', text: 'المحتجزات 5%' }],
    ['approve', { id: 'job-1', action: 'approve' }],
    ['cancel', { id: 'job-1', action: 'cancel' }],
  ];

  it.each(ACTIONS)('sends the %s action as the exact JSON body of a POST', async (_name, action) => {
    const impl = respondWith(200, { job: contractView() });
    const result = await actOnIntake(action);
    expect(result.ok).toBe(true);

    const [url, init] = impl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/copilot/api/intake');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(action);
  });

  it('returns the rebuilt job', async () => {
    const view = approvedView();
    respondWith(200, { job: view });
    const result = await actOnIntake({ id: 'job-1', action: 'approve' });
    expect(result).toEqual({ ok: true, job: view });
    if (result.ok) {
      expect(result.job.execution?.status).toBe('pending');
      expect(result.job.preview?.canApprove).toBe(true);
    }
  });

  it('approve answers with the executed job: done, with the step left for NPI marked manual', async () => {
    const view = executedView();
    respondWith(200, { job: view });
    const result = await actOnIntake({ id: 'job-1', action: 'approve' });
    expect(result).toEqual({ ok: true, job: view });
    if (result.ok) {
      expect(result.job.status).toBe('done');
      expect(result.job.execution?.steps.some((s) => s.state === 'manual')).toBe(true);
    }
  });

  it('approve answering with a job that stopped at a failed step is still a normal result, not an error', async () => {
    const view = executionFailedView();
    respondWith(200, { job: view });
    const result = await actOnIntake({ id: 'job-1', action: 'approve' });
    expect(result).toEqual({ ok: true, job: view });
  });

  it('maps 422 plan_failed to a refusal carrying the Arabic reason (the plan could not be built; nothing was written)', async () => {
    const messageAr = t('exec.error.plan', { reason: t('preview.item_required', { name: 'كابل نحاسي 6 ملم' }) });
    respondWith(422, { error: 'plan_failed', messageAr });
    const result = await actOnIntake({ id: 'job-1', action: 'approve' });
    expect(result).toMatchObject({ ok: false, messageAr });
  });

  it('maps 409 to state: the server’s message, or the default one', async () => {
    respondWith(409, { error: 'state', messageAr: t('intake.state_conflict') });
    expect(await actOnIntake({ id: 'job-1', action: 'approve' })).toEqual({ ok: false, kind: 'state', messageAr: t('intake.state_conflict') });

    respondWith(409, { error: 'state' });
    expect(await actOnIntake({ id: 'job-1', action: 'approve' })).toEqual({ ok: false, kind: 'state', messageAr: t('intake.state_conflict') });
  });

  it('maps 422 to edit_failed carrying the reason the model could not apply the sentence', async () => {
    respondWith(422, { error: 'edit_failed', messageAr: t('extract.failed.invalid_json') });
    expect(await actOnIntake({ id: 'job-1', action: 'edit', text: 'المحتجزات 5%' })).toEqual({
      ok: false,
      kind: 'edit_failed',
      messageAr: t('extract.failed.invalid_json'),
    });
  });

  it('maps 502 to npi with NPI’s own Arabic message', async () => {
    respondWith(502, { error: 'npi', messageAr: 'NPI رفض: ليست لك صلاحية تنفيذ هذا الإجراء.' });
    expect(await actOnIntake({ id: 'job-1', action: 'confirm', path: 'retentionPct' })).toEqual({
      ok: false,
      kind: 'npi',
      messageAr: 'NPI رفض: ليست لك صلاحية تنفيذ هذا الإجراء.',
    });
  });

  it('maps 404, 401, 503 and 500 like the loader', async () => {
    const action: IntakeAction = { id: 'job-1', action: 'cancel' };
    respondWith(404, { error: 'not_found' });
    expect(await actOnIntake(action)).toMatchObject({ ok: false, kind: 'not_found', messageAr: t('intake.not_found') });
    respondWith(401, {});
    expect(await actOnIntake(action)).toMatchObject({ ok: false, kind: 'unauthenticated' });
    respondWith(503, { messageAr: 'NPI متعطل' });
    expect(await actOnIntake(action)).toMatchObject({ ok: false, kind: 'npi_down', messageAr: 'NPI متعطل' });
    respondWith(500, { error: 'server' });
    expect(await actOnIntake(action)).toMatchObject({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('a 400 (a path or option the server refused) is a server error, not a crash', async () => {
    respondWith(400, { error: 'bad_request' });
    expect(await actOnIntake({ id: 'job-1', action: 'set', path: 'lines.9.qty', value: '1' })).toMatchObject({ ok: false, kind: 'server' });
  });

  it('a malformed 200 is a server error', async () => {
    respondWith(200, { job: { id: 'job-1' } });
    expect(await actOnIntake({ id: 'job-1', action: 'approve' })).toEqual({ ok: false, kind: 'server', messageAr: t('state.error') });
  });

  it('reports a network failure', async () => {
    mockFetch(
      jest.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await actOnIntake({ id: 'job-1', action: 'approve' })).toMatchObject({ ok: false, kind: 'network' });
  });
});
