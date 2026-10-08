// T-33 part A: the trust log's readers (`src/audit/query.ts`) against an
// in-memory fake db and a fake NPI directory. No network, no database. The
// real-database side is tests/audit-db.spec.ts.
import { t } from '../src/i18n/ar';
import { NpiError, type NpiErrorKind } from '../src/npi/errors';
import {
  AuditError,
  TRUST_PERMISSION,
  auditSummary,
  countPlaceholders,
  encodeCursor,
  eventLabelAr,
  getAuditRow,
  listAudit,
  parseCursor,
  parseOutbound,
  type AuditCaller,
  type AuditDbRow,
  type AuditQueryDb,
  type AuditQueryDeps,
  type AuditQueryNpi,
  type AuditWhere,
} from '../src/audit/query';
import { KNOWN_AUDIT_EVENTS } from '../src/audit/types';

// ─── Fakes ──────────────────────────────────────────────────────────────────

const ORG_A = 'org-a';
const ORG_B = 'org-b';

let seq = 0;
function row(overrides: Partial<AuditDbRow> = {}): AuditDbRow {
  seq += 1;
  return {
    id: `row${String(seq).padStart(4, '0')}`,
    ts: new Date('2026-10-06T10:00:00.000Z'),
    npiOrgId: ORG_A,
    npiUserId: 'u1',
    conversationId: null,
    intakeJobId: null,
    documentId: null,
    event: 'chat',
    modelTier: 'economy',
    modelId: 'claude-haiku',
    tokensIn: 10,
    tokensOut: 5,
    costUsdMicro: 100n,
    outboundRedactedText: null,
    imageSent: false,
    consentEventId: null,
    latencyMs: 200,
    error: null,
    ...overrides,
  };
}

interface FakeConsent {
  id: string;
  decision: 'approved' | 'cancelled';
  createdAt: Date;
}
interface FakeDocument {
  id: string;
  npiOrgId: string;
  fileName: string;
  kind: 'pdf_text' | 'pdf_scanned' | 'image';
}

function matches(r: AuditDbRow, where: AuditWhere): boolean {
  if (r.npiOrgId !== where.npiOrgId) return false;
  if (where.id !== undefined && r.id !== where.id) return false;
  if (where.event !== undefined && r.event !== where.event) return false;
  if (where.imageSent !== undefined && r.imageSent !== where.imageSent) return false;
  if (where.npiUserId !== undefined && r.npiUserId !== where.npiUserId) return false;
  if (where.consentEventId === null && r.consentEventId !== null) return false;
  if (where.error !== undefined && r.error === null) return false;
  if (where.OR !== undefined) {
    const hit = where.OR.some((clause) => {
      if ('id' in clause) return r.ts.getTime() === clause.ts.getTime() && r.id < clause.id.lt;
      return r.ts.getTime() < clause.ts.lt.getTime();
    });
    if (!hit) return false;
  }
  return true;
}

interface FakeFindManyArgs {
  where: AuditWhere;
  orderBy?: unknown;
  take?: number;
  distinct?: string[];
  select?: Record<string, true>;
}

function buildFakeDb(seed: { rows: AuditDbRow[]; consents?: FakeConsent[]; documents?: FakeDocument[] }) {
  const calls = { findMany: 0, consentFindMany: 0, documentFindMany: 0, wheres: [] as AuditWhere[] };
  const consents = seed.consents ?? [];
  const documents = seed.documents ?? [];

  const findMany = (args: FakeFindManyArgs): Promise<unknown[]> => {
    calls.findMany += 1;
    calls.wheres.push(args.where);
    let out = seed.rows.filter((r) => matches(r, args.where));
    if (args.distinct !== undefined) {
      const seen = new Set<string>();
      out = out.filter((r) => (seen.has(r.npiUserId) ? false : (seen.add(r.npiUserId), true)));
      return Promise.resolve(out.map((r) => ({ npiUserId: r.npiUserId })));
    }
    out = [...out].sort((a, b) => b.ts.getTime() - a.ts.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    if (args.take !== undefined) out = out.slice(0, args.take);
    return Promise.resolve(out.map((r) => ({ ...r })));
  };

  const db: AuditQueryDb = {
    llmAudit: {
      findMany: findMany as unknown as AuditQueryDb['llmAudit']['findMany'],
      async findFirst({ where }) {
        const found = seed.rows.find((r) => matches(r, where));
        return found ? { ...found } : null;
      },
      async count({ where }) {
        return seed.rows.filter((r) => matches(r, where)).length;
      },
    },
    consentEvent: {
      async findMany({ where }) {
        calls.consentFindMany += 1;
        return consents.filter((c) => where.id.in.includes(c.id));
      },
    },
    document: {
      async findMany({ where }) {
        calls.documentFindMany += 1;
        return documents
          .filter((d) => where.id.in.includes(d.id) && d.npiOrgId === where.npiOrgId)
          .map((d) => ({ id: d.id, fileName: d.fileName, kind: d.kind }));
      },
    },
  };
  return { db, calls };
}

function npiError(kind: NpiErrorKind): NpiError {
  return new NpiError({ status: kind === 'unauthorized' ? 401 : kind === 'forbidden' ? 403 : 0, kind, npiMessage: null });
}

function directoryNpi(users: Array<{ id: string; nameAr: string }>): AuditQueryNpi {
  return {
    async listDepartmentDirectory() {
      return users.map((u) => ({ id: u.id, isActive: true, nameAr: u.nameAr, role: { key: 'staff' } }));
    },
  };
}

function failingNpi(kind: NpiErrorKind): AuditQueryNpi {
  return {
    async listDepartmentDirectory() {
      throw npiError(kind);
    },
  };
}

function adminOf(npiOrgId: string): AuditCaller {
  return { npiOrgId, npiUserId: 'admin', permissions: [TRUST_PERMISSION] };
}

const NO_FILTERS = {};

function depsOf(rows: AuditDbRow[], npi: AuditQueryNpi = directoryNpi([]), extra: Parameters<typeof buildFakeDb>[0] extends infer S ? Partial<S> : never = {}): AuditQueryDeps {
  return { db: buildFakeDb({ rows, ...extra }).db, npi };
}

// ─── 1. permission ──────────────────────────────────────────────────────────

describe('permission', () => {
  const noPermission: AuditCaller = { npiOrgId: ORG_A, npiUserId: 'u1', permissions: ['inventory.read'] };

  it('listAudit without admin.user.manage throws AuditError 403 with the trust.forbidden text', async () => {
    const deps = depsOf([row()]);
    const err = await listAudit(deps, noPermission, { filters: NO_FILTERS, cursor: null, limit: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect(err).toMatchObject({ code: 'forbidden', status: 403, messageAr: t('trust.forbidden') });
  });

  it('getAuditRow without admin.user.manage throws AuditError 403 with the trust.forbidden text', async () => {
    const r = row();
    const deps = depsOf([r]);
    const err = await getAuditRow(deps, noPermission, r.id).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect(err).toMatchObject({ code: 'forbidden', status: 403, messageAr: t('trust.forbidden') });
  });

  it('checks the permission before reading anything', async () => {
    const fake = buildFakeDb({ rows: [row()] });
    await expect(
      listAudit({ db: fake.db, npi: directoryNpi([]) }, noPermission, { filters: NO_FILTERS, cursor: null, limit: 50 }),
    ).rejects.toBeInstanceOf(AuditError);
    expect(fake.calls.findMany).toBe(0);
  });
});

// ─── 2. organization scoping ────────────────────────────────────────────────

describe('organization scoping', () => {
  it("never returns org B's rows to org A's caller, and puts npiOrgId in every where", async () => {
    const a1 = row({ npiOrgId: ORG_A });
    const b1 = row({ npiOrgId: ORG_B, npiUserId: 'ub' });
    const fake = buildFakeDb({ rows: [a1, b1] });
    const view = await listAudit({ db: fake.db, npi: directoryNpi([]) }, adminOf(ORG_A), {
      filters: NO_FILTERS,
      cursor: null,
      limit: 50,
    });
    expect(view.rows.map((r) => r.id)).toEqual([a1.id]);
    expect(fake.calls.wheres.length).toBeGreaterThan(0);
    for (const where of fake.calls.wheres) expect(where.npiOrgId).toBe(ORG_A);
  });

  it("getAuditRow of org B's id for org A's caller is null (no 403, no existence hint)", async () => {
    const b1 = row({ npiOrgId: ORG_B });
    const deps = depsOf([b1]);
    await expect(getAuditRow(deps, adminOf(ORG_A), b1.id)).resolves.toBeNull();
    await expect(getAuditRow(deps, adminOf(ORG_B), b1.id)).resolves.toMatchObject({ id: b1.id });
  });

  it('summary and users of org A count only org A', async () => {
    const rows = [
      row({ npiOrgId: ORG_A, npiUserId: 'u1' }),
      row({ npiOrgId: ORG_A, npiUserId: 'u2', error: 'timeout' }),
      row({ npiOrgId: ORG_B, npiUserId: 'ub', error: 'timeout' }),
      row({ npiOrgId: ORG_B, npiUserId: 'ub2', imageSent: true, consentEventId: 'c9' }),
    ];
    const view = await listAudit(depsOf(rows), adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 50 });
    expect(view.summary).toEqual({ total: 2, imageSent: 0, imageSentWithoutConsent: 0, errors: 1 });
    expect(view.users.map((u) => u.npiUserId).sort()).toEqual(['u1', 'u2']);
  });

  it("a document of another organization behind a row's documentId resolves to null", async () => {
    const r = row({ documentId: 'docB' });
    const deps = depsOf([r], directoryNpi([]), {
      documents: [{ id: 'docB', npiOrgId: ORG_B, fileName: 'other.pdf', kind: 'pdf_text' }],
    });
    const view = await listAudit(deps, adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 50 });
    expect(view.rows[0].document).toBeNull();
  });
});

// ─── 3 + 4. ordering and pagination ─────────────────────────────────────────

describe('ordering', () => {
  it('lists newest first and breaks a tie on ts by id descending', async () => {
    const same = new Date('2026-10-06T09:00:00.000Z');
    const older = row({ id: 'r_old', ts: new Date('2026-10-06T08:00:00.000Z') });
    const tieA = row({ id: 'r_aaa', ts: same });
    const tieB = row({ id: 'r_bbb', ts: same });
    const newest = row({ id: 'r_new', ts: new Date('2026-10-06T10:00:00.000Z') });
    const view = await listAudit(depsOf([older, tieA, newest, tieB]), adminOf(ORG_A), {
      filters: NO_FILTERS,
      cursor: null,
      limit: 50,
    });
    expect(view.rows.map((r) => r.id)).toEqual(['r_new', 'r_bbb', 'r_aaa', 'r_old']);
    expect(view.nextCursor).toBeNull();
  });
});

describe('pagination', () => {
  function sevenRows(): AuditDbRow[] {
    // Two share a ts so the id tie-break is exercised across a page boundary.
    const base = Date.UTC(2026, 9, 6, 12, 0, 0);
    return [0, 1, 2, 3, 4, 5, 6].map((i) =>
      row({ id: `p${i}`, ts: new Date(base - (i === 4 ? 3 : i) * 60_000) }),
    );
  }

  it('walks 7 rows with limit 3 as 3 + 3 + 1 with no duplicates and no gaps', async () => {
    const rows = sevenRows();
    const deps = depsOf(rows);
    const caller = adminOf(ORG_A);

    const first = await listAudit(deps, caller, { filters: NO_FILTERS, cursor: null, limit: 3 });
    expect(first.rows).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAudit(deps, caller, { filters: NO_FILTERS, cursor: first.nextCursor, limit: 3 });
    expect(second.rows).toHaveLength(3);
    expect(second.nextCursor).not.toBeNull();

    const third = await listAudit(deps, caller, { filters: NO_FILTERS, cursor: second.nextCursor, limit: 3 });
    expect(third.rows).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const union = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(new Set(union).size).toBe(7);
    const all = await listAudit(deps, caller, { filters: NO_FILTERS, cursor: null, limit: 50 });
    expect(union).toEqual(all.rows.map((r) => r.id));
  });

  it('a page that ends exactly at the last row has no cursor', async () => {
    const view = await listAudit(depsOf(sevenRows()), adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 7 });
    expect(view.rows).toHaveLength(7);
    expect(view.nextCursor).toBeNull();
  });

  it('clamps an out-of-range limit instead of failing', async () => {
    const view = await listAudit(depsOf(sevenRows()), adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 0 });
    expect(view.rows).toHaveLength(1);
    expect(view.nextCursor).not.toBeNull();
  });

  it('a malformed cursor throws AuditError bad_cursor (400, t(state.error))', async () => {
    const err = await listAudit(depsOf([row()]), adminOf(ORG_A), {
      filters: NO_FILTERS,
      cursor: 'garbage',
      limit: 3,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect(err).toMatchObject({ code: 'bad_cursor', status: 400, messageAr: t('state.error') });
  });

  it('encodeCursor / parseCursor round-trip', () => {
    const ts = new Date('2026-10-06T12:34:56.789Z');
    const raw = encodeCursor({ ts, id: 'abc_DEF-123' });
    expect(raw).toBe('2026-10-06T12:34:56.789Z|abc_DEF-123');
    const parsed = parseCursor(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.ts.getTime()).toBe(ts.getTime());
    expect(parsed?.id).toBe('abc_DEF-123');
  });

  it.each([
    ['empty', ''],
    ['no bar', 'x'],
    ['bad date', 'notadate|id'],
    ['empty id', '2026-10-06T00:00:00.000Z|'],
    ['id with a space', '2026-10-06T00:00:00.000Z|a b'],
    ['id with a second bar', '2026-10-06T00:00:00.000Z|a|b'],
    ['no date', '|abc'],
    ['id over 64 chars', `2026-10-06T00:00:00.000Z|${'a'.repeat(65)}`],
  ])('parseCursor rejects %s', (_name, raw) => {
    expect(parseCursor(raw)).toBeNull();
  });
});

// ─── 5. filters ─────────────────────────────────────────────────────────────

describe('filters', () => {
  const rows = [
    row({ id: 'f1', ts: new Date('2026-10-06T10:05:00.000Z'), event: 'chat', npiUserId: 'u1' }),
    row({
      id: 'f2',
      ts: new Date('2026-10-06T10:04:00.000Z'),
      event: 'extract_vendor_bill',
      npiUserId: 'u1',
      imageSent: true,
      consentEventId: 'c1',
    }),
    row({ id: 'f3', ts: new Date('2026-10-06T10:03:00.000Z'), event: 'extract_vendor_bill', npiUserId: 'u2' }),
    row({
      id: 'f4',
      ts: new Date('2026-10-06T10:02:00.000Z'),
      event: 'refused_confidential',
      npiUserId: 'u2',
      modelId: null,
      modelTier: null,
    }),
  ];
  const ids = async (filters: Parameters<typeof listAudit>[2]['filters']) =>
    (await listAudit(depsOf(rows), adminOf(ORG_A), { filters, cursor: null, limit: 50 })).rows.map((r) => r.id);

  it('event alone is an exact match', async () => {
    expect(await ids({ event: 'extract_vendor_bill' })).toEqual(['f2', 'f3']);
    expect(await ids({ event: 'extract_vendor' })).toEqual([]);
  });

  it('imageSent alone', async () => {
    expect(await ids({ imageSent: true })).toEqual(['f2']);
    expect(await ids({ imageSent: false })).toEqual(['f1', 'f3', 'f4']);
  });

  it('npiUserId alone', async () => {
    expect(await ids({ npiUserId: 'u2' })).toEqual(['f3', 'f4']);
  });

  it('all three together', async () => {
    expect(await ids({ event: 'extract_vendor_bill', imageSent: true, npiUserId: 'u1' })).toEqual(['f2']);
    expect(await ids({ event: 'extract_vendor_bill', imageSent: true, npiUserId: 'u2' })).toEqual([]);
  });

  it('summary and users ignore the filters', async () => {
    const view = await listAudit(depsOf(rows), adminOf(ORG_A), {
      filters: { event: 'chat' },
      cursor: null,
      limit: 50,
    });
    expect(view.rows).toHaveLength(1);
    expect(view.summary.total).toBe(4);
    expect(view.summary.imageSent).toBe(1);
    expect(view.users.map((u) => u.npiUserId)).toEqual(['u1', 'u2']);
  });
});

// ─── 6. row mapping ─────────────────────────────────────────────────────────

describe('row mapping', () => {
  it('maps every field and resolves consent, document and the user name', async () => {
    const r = row({
      id: 'm1',
      ts: new Date('2026-10-06T10:00:00.000Z'),
      npiUserId: 'u1',
      conversationId: 'conv1',
      intakeJobId: 'job1',
      documentId: 'doc1',
      event: 'extract_vendor_bill',
      modelTier: 'advanced',
      modelId: 'claude-sonnet',
      tokensIn: 1200,
      tokensOut: 300,
      costUsdMicro: 48236n,
      outboundRedactedText: 'x'.repeat(321),
      imageSent: true,
      consentEventId: 'c1',
      latencyMs: 1500,
      error: null,
    });
    const deps = depsOf([r], directoryNpi([{ id: 'u1', nameAr: 'أحمد' }]), {
      consents: [{ id: 'c1', decision: 'approved', createdAt: new Date('2026-10-06T09:59:00.000Z') }],
      documents: [{ id: 'doc1', npiOrgId: ORG_A, fileName: 'bill.jpg', kind: 'image' }],
    });
    const view = await listAudit(deps, adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 50 });
    expect(view.rows[0]).toEqual({
      id: 'm1',
      ts: '2026-10-06T10:00:00.000Z',
      npiUserId: 'u1',
      userNameAr: 'أحمد',
      event: 'extract_vendor_bill',
      eventLabelAr: t('trust.event.extract_vendor_bill'),
      kind: 'model',
      modelTier: 'advanced',
      modelId: 'claude-sonnet',
      tokensIn: 1200,
      tokensOut: 300,
      costUsdMicro: '48236',
      latencyMs: 1500,
      imageSent: true,
      consent: { id: 'c1', decision: 'approved', createdAt: '2026-10-06T09:59:00.000Z' },
      document: { id: 'doc1', fileName: 'bill.jpg', kind: 'image' },
      conversationId: 'conv1',
      intakeJobId: 'job1',
      error: null,
      outboundChars: 321,
    });
    // The list never carries the text itself.
    expect(JSON.stringify(view)).not.toContain('xxxxxxxxxx');
    expect(view.rows[0]).not.toHaveProperty('outboundRedactedText');
  });

  it('serialises to JSON without a bigint (the route would throw on one)', async () => {
    const view = await listAudit(depsOf([row({ costUsdMicro: 48236n })]), adminOf(ORG_A), {
      filters: NO_FILTERS,
      cursor: null,
      limit: 50,
    });
    expect(() => JSON.stringify(view)).not.toThrow();
    expect(view.rows[0].costUsdMicro).toBe('48236');
  });

  it("kind is 'system' when no model was called", async () => {
    const view = await listAudit(
      depsOf([row({ event: 'refused_confidential', modelId: null, modelTier: null, costUsdMicro: 0n })]),
      adminOf(ORG_A),
      { filters: NO_FILTERS, cursor: null, limit: 50 },
    );
    expect(view.rows[0]).toMatchObject({ kind: 'system', modelTier: null, modelId: null, costUsdMicro: '0' });
  });

  it('modelTier passes economy/advanced through and is null for an unknown tier string', async () => {
    const rows = [
      row({ id: 't1', ts: new Date('2026-10-06T10:03:00.000Z'), modelTier: 'economy' }),
      row({ id: 't2', ts: new Date('2026-10-06T10:02:00.000Z'), modelTier: 'advanced' }),
      row({ id: 't3', ts: new Date('2026-10-06T10:01:00.000Z'), modelTier: 'turbo' }),
    ];
    const view = await listAudit(depsOf(rows), adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 50 });
    expect(view.rows.map((r) => r.modelTier)).toEqual(['economy', 'advanced', null]);
  });

  it('outboundChars is the stored length, and 0 for a null text', async () => {
    const rows = [
      row({ id: 'o1', ts: new Date('2026-10-06T10:02:00.000Z'), outboundRedactedText: 'مرحبا ⟦عميل_1⟧' }),
      row({ id: 'o2', ts: new Date('2026-10-06T10:01:00.000Z'), outboundRedactedText: null }),
    ];
    const view = await listAudit(depsOf(rows), adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 50 });
    expect(view.rows[0].outboundChars).toBe('مرحبا ⟦عميل_1⟧'.length);
    expect(view.rows[1].outboundChars).toBe(0);
  });

  it('userNameAr is null for an id the directory does not know', async () => {
    const rows = [
      row({ id: 'n1', ts: new Date('2026-10-06T10:02:00.000Z'), npiUserId: 'u1' }),
      row({ id: 'n2', ts: new Date('2026-10-06T10:01:00.000Z'), npiUserId: 'ghost' }),
    ];
    const view = await listAudit(depsOf(rows, directoryNpi([{ id: 'u1', nameAr: 'سارة' }])), adminOf(ORG_A), {
      filters: NO_FILTERS,
      cursor: null,
      limit: 50,
    });
    expect(view.rows.map((r) => r.userNameAr)).toEqual(['سارة', null]);
  });

  it('a consent id the table no longer holds resolves to null, not a throw', async () => {
    const r = row({ imageSent: true, consentEventId: 'gone' });
    const view = await listAudit(depsOf([r]), adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 50 });
    expect(view.rows[0].consent).toBeNull();
    expect(view.rows[0].imageSent).toBe(true);
  });

  it('a missing document resolves to null', async () => {
    const r = row({ documentId: 'gone' });
    const view = await listAudit(depsOf([r]), adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 50 });
    expect(view.rows[0].document).toBeNull();
  });

  it('joins with two queries per page, not one per row', async () => {
    const rows = [1, 2, 3, 4].map((i) =>
      row({ ts: new Date(Date.UTC(2026, 9, 6, 10, i)), documentId: `doc${i}`, imageSent: true, consentEventId: `c${i}` }),
    );
    const fake = buildFakeDb({ rows });
    await listAudit({ db: fake.db, npi: directoryNpi([]) }, adminOf(ORG_A), {
      filters: NO_FILTERS,
      cursor: null,
      limit: 50,
    });
    expect(fake.calls.consentFindMany).toBe(1);
    expect(fake.calls.documentFindMany).toBe(1);
  });

  it('getAuditRow carries the parsed outbound text and the same mapping', async () => {
    const outbound = JSON.stringify({ system: 'S ⟦عميل_1⟧', messages: [{ role: 'user', content: 'x' }] });
    const r = row({ id: 'd1', outboundRedactedText: outbound });
    const detail = await getAuditRow(depsOf([r]), adminOf(ORG_A), 'd1');
    expect(detail).not.toBeNull();
    expect(detail?.outboundChars).toBe(outbound.length);
    expect(detail?.outbound).toEqual({
      kind: 'parsed',
      system: 'S ⟦عميل_1⟧',
      messages: [{ role: 'user', content: 'x' }],
      placeholderCount: 1,
    });
  });

  it('getAuditRow of a row that sent nothing has outbound null', async () => {
    const r = row({ id: 'd2', outboundRedactedText: null });
    const detail = await getAuditRow(depsOf([r]), adminOf(ORG_A), 'd2');
    expect(detail?.outbound).toBeNull();
    expect(detail?.outboundChars).toBe(0);
  });

  it('users are sorted by Arabic name with unnamed ones last, then by id', async () => {
    const rows = [
      row({ npiUserId: 'u_z', ts: new Date('2026-10-06T10:05:00.000Z') }),
      row({ npiUserId: 'u_b', ts: new Date('2026-10-06T10:04:00.000Z') }),
      row({ npiUserId: 'u_a', ts: new Date('2026-10-06T10:03:00.000Z') }),
      row({ npiUserId: 'u_c', ts: new Date('2026-10-06T10:02:00.000Z') }),
    ];
    const npi = directoryNpi([
      { id: 'u_b', nameAr: 'بسمة' },
      { id: 'u_c', nameAr: 'أحمد' },
    ]);
    const view = await listAudit(depsOf(rows, npi), adminOf(ORG_A), { filters: NO_FILTERS, cursor: null, limit: 50 });
    expect(view.users).toEqual([
      { npiUserId: 'u_c', nameAr: 'أحمد' },
      { npiUserId: 'u_b', nameAr: 'بسمة' },
      { npiUserId: 'u_a', nameAr: null },
      { npiUserId: 'u_z', nameAr: null },
    ]);
  });
});

// ─── 7. event labels ────────────────────────────────────────────────────────

describe('eventLabelAr', () => {
  it.each([...KNOWN_AUDIT_EVENTS])('labels the known event %s with its trust.event key', (event) => {
    expect(eventLabelAr(event)).toBe(t(`trust.event.${event}` as Parameters<typeof t>[0]));
    expect(eventLabelAr(event)).not.toBe(t('trust.event.other'));
  });

  it('labels an unknown event as trust.event.other', () => {
    expect(eventLabelAr('something_new')).toBe(t('trust.event.other'));
  });

  it('the row view uses the same label and keeps the raw key', async () => {
    const view = await listAudit(depsOf([row({ event: 'something_new' })]), adminOf(ORG_A), {
      filters: NO_FILTERS,
      cursor: null,
      limit: 50,
    });
    expect(view.rows[0]).toMatchObject({ event: 'something_new', eventLabelAr: t('trust.event.other') });
  });
});

// ─── 8. directory ───────────────────────────────────────────────────────────

describe('directory', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const opts = { filters: NO_FILTERS, cursor: null, limit: 50 };

  it('forbidden: names are null, nothing thrown, nothing logged', async () => {
    const view = await listAudit(depsOf([row()], failingNpi('forbidden')), adminOf(ORG_A), opts);
    expect(view.rows[0].userNameAr).toBeNull();
    expect(view.users).toEqual([{ npiUserId: 'u1', nameAr: null }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['network', 'unexpected', 'server', 'timeout'] as const)(
    '%s: names are null, nothing thrown, one console.warn naming the kind',
    async (kind) => {
      const view = await listAudit(depsOf([row()], failingNpi(kind)), adminOf(ORG_A), opts);
      expect(view.rows).toHaveLength(1);
      expect(view.rows[0].userNameAr).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[copilot] trust: directory unavailable', kind);
    },
  );

  it('a directory body of an unexpected shape is tolerated the same way', async () => {
    const npi: AuditQueryNpi = { listDepartmentDirectory: async () => ({ not: 'an array' }) };
    const view = await listAudit(depsOf([row()], npi), adminOf(ORG_A), opts);
    expect(view.rows[0].userNameAr).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[copilot] trust: directory unavailable', 'unexpected');
  });

  it('unauthorized propagates the NpiError (list and detail)', async () => {
    const r = row();
    const deps = depsOf([r], failingNpi('unauthorized'));
    await expect(listAudit(deps, adminOf(ORG_A), opts)).rejects.toMatchObject({ name: 'NpiError', kind: 'unauthorized' });
    await expect(getAuditRow(deps, adminOf(ORG_A), r.id)).rejects.toMatchObject({ name: 'NpiError', kind: 'unauthorized' });
  });

  it('getAuditRow of an absent row does not call the directory at all', async () => {
    const npi: AuditQueryNpi = {
      listDepartmentDirectory: jest.fn(async () => {
        throw npiError('unauthorized');
      }),
    };
    await expect(getAuditRow(depsOf([], npi), adminOf(ORG_A), 'nope')).resolves.toBeNull();
    expect(npi.listDepartmentDirectory).not.toHaveBeenCalled();
  });
});

// ─── 9. parseOutbound ───────────────────────────────────────────────────────

describe('parseOutbound', () => {
  it('null stays null', () => {
    expect(parseOutbound(null)).toBeNull();
  });

  it('the real shape is parsed with its blocks intact', () => {
    const body = {
      system: 'أنت مدار. العميل ⟦عميل_1⟧',
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'اقرأ هذه الفاتورة من ⟦عميل_2⟧' },
            { type: 'image', mediaType: 'image/png', sizeBytes: 10, consentEventId: 'c1' },
          ],
        },
      ],
    };
    const out = parseOutbound(JSON.stringify(body));
    expect(out).toEqual({ kind: 'parsed', system: body.system, messages: body.messages, placeholderCount: 2 });
  });

  it('a document block (PDF) is accepted like an image block', () => {
    const body = {
      system: 's',
      messages: [
        { role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', sizeBytes: 99, consentEventId: 'c2' }] },
      ],
    };
    expect(parseOutbound(JSON.stringify(body))).toMatchObject({ kind: 'parsed' });
  });

  it('an assistant message and empty messages are accepted', () => {
    expect(parseOutbound(JSON.stringify({ system: '', messages: [] }))).toMatchObject({ kind: 'parsed' });
    expect(
      parseOutbound(JSON.stringify({ system: 's', messages: [{ role: 'assistant', content: 'ok' }] })),
    ).toMatchObject({ kind: 'parsed' });
  });

  it('invalid JSON is raw, verbatim', () => {
    const text = 'not json ⟦عميل_1⟧';
    expect(parseOutbound(text)).toEqual({ kind: 'raw', text, placeholderCount: 1 });
  });

  it.each([
    ['an object of another shape', JSON.stringify({ a: 1 })],
    ['an array', JSON.stringify([{ role: 'user', content: 'x' }])],
    ['a string', JSON.stringify('hello')],
    ['no system', JSON.stringify({ messages: [] })],
    ['messages that are not an array', JSON.stringify({ system: 's', messages: 'x' })],
    ['a message with role system', JSON.stringify({ system: 's', messages: [{ role: 'system', content: 'x' }] })],
    ['a message without content', JSON.stringify({ system: 's', messages: [{ role: 'user' }] })],
    [
      'a vision block missing consentEventId',
      JSON.stringify({
        system: 's',
        messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', sizeBytes: 10 }] }],
      }),
    ],
    [
      'a vision block with a non-numeric size',
      JSON.stringify({
        system: 's',
        messages: [
          { role: 'user', content: [{ type: 'image', mediaType: 'image/png', sizeBytes: '10', consentEventId: 'c1' }] },
        ],
      }),
    ],
    [
      'a text block without text',
      JSON.stringify({ system: 's', messages: [{ role: 'user', content: [{ type: 'text' }] }] }),
    ],
    [
      'a block of an unknown type',
      JSON.stringify({ system: 's', messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }] }] }),
    ],
  ])('%s is shown raw, not dropped', (_name, text) => {
    expect(parseOutbound(text)).toEqual({ kind: 'raw', text, placeholderCount: 0 });
  });

  it('a vision block with extra keys is still accepted', () => {
    const body = {
      system: 's',
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', mediaType: 'application/pdf', sizeBytes: 1, consentEventId: 'c1', title: 'x' }],
        },
      ],
    };
    expect(parseOutbound(JSON.stringify(body))).toMatchObject({ kind: 'parsed' });
  });
});

describe('countPlaceholders', () => {
  it('counts ⟦عميل_1⟧ … ⟦هاتف_2⟧ and ignores a lone ⟦', () => {
    expect(countPlaceholders('اتصل بـ ⟦عميل_1⟧ على ⟦هاتف_2⟧')).toBe(2);
    expect(countPlaceholders('⟦ وحيدة')).toBe(0);
    expect(countPlaceholders('⟦⟧')).toBe(0);
    expect(countPlaceholders('⟦عميل_1⟧ و ⟦')).toBe(1);
    expect(countPlaceholders('')).toBe(0);
  });

  it('is the same count in the parsed and the raw branch', () => {
    const body = { system: '⟦عميل_1⟧', messages: [{ role: 'user', content: '⟦هاتف_2⟧ ⟦ ' }] };
    const parsed = parseOutbound(JSON.stringify(body));
    const raw = parseOutbound(`${JSON.stringify(body)} trailing`);
    expect(parsed).toMatchObject({ kind: 'parsed', placeholderCount: 2 });
    expect(raw).toMatchObject({ kind: 'raw', placeholderCount: 2 });
  });
});

// ─── 10. summary ────────────────────────────────────────────────────────────

describe('auditSummary', () => {
  it('counts total, imageSent, imageSent without consent, and errors on the organization', async () => {
    const rows = [
      row({ id: 's1' }),
      row({ id: 's2', imageSent: true, consentEventId: 'c1' }),
      row({ id: 's3', imageSent: true, consentEventId: 'c2', error: 'timeout' }),
      // The real DB CHECK forbids this row; the fake can hold it to prove the count works.
      row({ id: 's4', imageSent: true, consentEventId: null }),
      row({ id: 's5', error: 'refused' }),
      row({ id: 's6', npiOrgId: ORG_B, imageSent: true, consentEventId: null, error: 'x' }),
    ];
    const { db } = buildFakeDb({ rows });
    expect(await auditSummary(db, ORG_A)).toEqual({
      total: 5,
      imageSent: 3,
      imageSentWithoutConsent: 1,
      errors: 2,
    });
    expect(await auditSummary(db, ORG_B)).toEqual({ total: 1, imageSent: 1, imageSentWithoutConsent: 1, errors: 1 });
  });

  it('a clean organization has imageSentWithoutConsent 0 and an empty one is all zeros', async () => {
    const { db } = buildFakeDb({ rows: [row({ imageSent: true, consentEventId: 'c1' })] });
    expect((await auditSummary(db, ORG_A)).imageSentWithoutConsent).toBe(0);
    expect(await auditSummary(db, 'nobody')).toEqual({ total: 0, imageSent: 0, imageSentWithoutConsent: 0, errors: 0 });
  });
});
