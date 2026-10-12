import { readFileSync } from 'node:fs';
import path from 'node:path';

// Point the prompt loader at the real `apps/copilot/prompts` folder before
// anything under test imports it — `loadPrompt`'s root is resolved lazily
// (on each call), so setting the env var here is enough; no module reset
// needed.
process.env.COPILOT_PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

import { loadPrompt, clearPromptCache } from '../src/prompts/load';
import { BORROWED_PERSONAS, KNOWN_ROLE_KEYS, personaFileFor, loadPersona, buildTitleAr } from '../src/positions/persona';
import { resolvePosition, type PositionsDb, type PositionsNpi } from '../src/positions/resolve';
import { NpiError } from '../src/npi/errors';
import type { NpiMe } from '../src/npi/responses';
import type { Position, PositionAssignment } from '../src/generated/prisma';

const PROMPTS_ROOT = path.join(__dirname, '..', 'prompts');

// ─── src/prompts/load.ts ────────────────────────────────────────────────────

describe('loadPrompt', () => {
  beforeEach(() => clearPromptCache());

  it('rejects a path containing ".."', () => {
    expect(() => loadPrompt('../../etc/passwd.md')).toThrow();
  });

  it('rejects an absolute path', () => {
    const absolute = path.join(PROMPTS_ROOT, 'positions', 'admin.md');
    expect(() => loadPrompt(absolute)).toThrow();
  });

  it('rejects a path that does not end in ".md"', () => {
    expect(() => loadPrompt('positions/admin.txt')).toThrow();
  });

  it('reads and caches a real prompt file', () => {
    const first = loadPrompt('positions/admin.md');
    const onDisk = readFileSync(path.join(PROMPTS_ROOT, 'positions', 'admin.md'), 'utf8');
    expect(first).toBe(onDisk);
    // Second read comes from the cache, not a second `readFileSync` — we
    // can't spy on the module-private fs call, so instead assert the cache
    // truly serves a stable value across calls.
    expect(loadPrompt('positions/admin.md')).toBe(first);
  });
});

// ─── src/positions/persona.ts ───────────────────────────────────────────────

describe('personaFileFor / loadPersona', () => {
  it.each(KNOWN_ROLE_KEYS)('loads its own persona file for role "%s"', (roleKey) => {
    expect(personaFileFor(roleKey)).toBe(`positions/${roleKey}.md`);
    const onDisk = readFileSync(path.join(PROMPTS_ROOT, 'positions', `${roleKey}.md`), 'utf8');
    expect(loadPersona(roleKey)).toBe(onDisk);
  });

  it.each(['manager', '../../etc/passwd', '', 'ADMIN'])(
    'falls back to default.md for an unknown/hostile role key "%s"',
    (roleKey) => {
      expect(personaFileFor(roleKey)).toBe('positions/default.md');
      const onDisk = readFileSync(path.join(PROMPTS_ROOT, 'positions', 'default.md'), 'utf8');
      expect(loadPersona(roleKey)).toBe(onDisk);
    },
  );

  // ADR-02 §3-4: the company presets add three role keys and rename three.
  it.each([
    ['finance_manager', 'accountant'],
    ['warehouse_keeper', 'site_engineer'],
  ])('lends the preset role "%s" the persona of "%s"', (roleKey, persona) => {
    expect(personaFileFor(roleKey)).toBe(`positions/${persona}.md`);
    const onDisk = readFileSync(path.join(PROMPTS_ROOT, 'positions', `${persona}.md`), 'utf8');
    expect(loadPersona(roleKey)).toBe(onDisk);
  });

  it.each(['technical_office', 'executive', '__proto__', 'constructor', 'toString'])(
    'gives "%s" the default persona (no persona of its own, nothing borrowed)',
    (roleKey) => {
      expect(personaFileFor(roleKey)).toBe('positions/default.md');
    },
  );

  it('borrows only from the five known personas, never for one of the five', () => {
    for (const [roleKey, persona] of BORROWED_PERSONAS) {
      expect(KNOWN_ROLE_KEYS).toContain(persona);
      expect(KNOWN_ROLE_KEYS as readonly string[]).not.toContain(roleKey);
    }
  });

  // A persona read by more than one role, or by a role NPI renames, carries
  // no role title of its own: the position line above it has NPI's role name.
  // Titles are matched as whole words, before and after the presets' renames.
  const ROLE_TITLES = [
    'محاسب',
    'المحاسب',
    'مدير مشاريع',
    'مدير المشاريع',
    'مدير عام المشاريع',
    'موظف المشاريع',
    'مهندس موقع',
    'مهندس الموقع',
    'مهندس المشاريع',
    'أمين المستودع',
    'الإدارة المالية',
    'الإدارة العليا',
    'المدير العام',
  ];
  it.each(['accountant', 'pm', 'site_engineer'])('persona file "%s.md" names no role title', (name) => {
    const text = readFileSync(path.join(PROMPTS_ROOT, 'positions', `${name}.md`), 'utf8');
    const words = text.split(/[\s،؛.:—«»()]+/).filter((word) => word.length > 0);
    const named = ROLE_TITLES.filter((title) => {
      const parts = title.split(' ');
      return words.some((_, i) => parts.every((part, j) => words[i + j] === part));
    });
    expect(named).toEqual([]);
  });

  const ALL_PERSONA_FILES = [...KNOWN_ROLE_KEYS, 'default'];

  it.each(ALL_PERSONA_FILES)('persona file "%s.md" has no Latin letters other than "NPI"', (name) => {
    const text = readFileSync(path.join(PROMPTS_ROOT, 'positions', `${name}.md`), 'utf8');
    const latinRuns = text.match(/[A-Za-z]+/g) ?? [];
    const nonNpi = latinRuns.filter((run) => run !== 'NPI');
    expect(nonNpi).toEqual([]);
  });

  it.each(ALL_PERSONA_FILES)('persona file "%s.md" mentions «اعتمد»', (name) => {
    const text = readFileSync(path.join(PROMPTS_ROOT, 'positions', `${name}.md`), 'utf8');
    expect(text.includes('اعتمد')).toBe(true);
  });
});

describe('buildTitleAr', () => {
  it('joins role and department with an em dash when a department is given', () => {
    expect(buildTitleAr('محاسب', 'المالية')).toBe('محاسب — المالية');
  });

  it('returns just the role when there is no department', () => {
    expect(buildTitleAr('محاسب', null)).toBe('محاسب');
  });
});

// ─── src/positions/resolve.ts ───────────────────────────────────────────────

type FakeDb = PositionsDb & { positions: Position[]; assignments: PositionAssignment[] };

function createFakeDb(): FakeDb {
  let posSeq = 0;
  let asgSeq = 0;
  const positions: Position[] = [];
  const assignments: PositionAssignment[] = [];

  const db: FakeDb = {
    positions,
    assignments,
    position: {
      async findFirst({ where }) {
        return (
          positions.find(
            (p) =>
              p.npiOrgId === where.npiOrgId &&
              p.roleKey === where.roleKey &&
              p.departmentId === where.departmentId,
          ) ?? null
        );
      },
      async create({ data }) {
        const now = new Date();
        const row = {
          id: `pos-${++posSeq}`,
          npiOrgId: data.npiOrgId,
          roleKey: data.roleKey,
          departmentId: data.departmentId,
          titleAr: data.titleAr,
          personaAr: data.personaAr,
          createdAt: now,
          updatedAt: now,
        } as Position;
        positions.push(row);
        return row;
      },
    },
    positionAssignment: {
      async findFirst({ where, include }) {
        const found = assignments.find((a) => {
          if (a.npiUserId !== where.npiUserId || a.endedAt !== where.endedAt) return false;
          if (where.positionId !== undefined && a.positionId !== where.positionId) return false;
          if (where.position) {
            const p = positions.find((row) => row.id === a.positionId);
            if (!p) return false;
            if (p.npiOrgId !== where.position.npiOrgId || p.roleKey !== where.position.roleKey) {
              return false;
            }
          }
          return true;
        });
        if (!found) return null;
        if (include?.position) {
          const position = positions.find((p) => p.id === found.positionId);
          return { ...found, position };
        }
        return found;
      },
      async create({ data }) {
        const now = new Date();
        const row = {
          id: `asg-${++asgSeq}`,
          positionId: data.positionId,
          npiUserId: data.npiUserId,
          startedAt: now,
          endedAt: null,
          handoverDocId: null,
          createdAt: now,
          updatedAt: now,
        } as PositionAssignment;
        assignments.push(row);
        return row;
      },
    },
  };
  return db;
}

function makeMe(overrides: Partial<NpiMe> = {}): NpiMe {
  return {
    id: 'user-1',
    organizationId: 'org-1',
    nameAr: 'مستخدم',
    roleKey: 'accountant',
    roleNameAr: 'محاسب',
    permissions: [],
    orgNameAr: null,
    ...overrides,
  };
}

/** Both NPI methods throw by default — any test that expects "no NPI call"
 *  fails loudly (rather than silently) if resolution calls one anyway. */
function createUncalledNpi(): PositionsNpi {
  return {
    listDepartments: jest.fn(async () => {
      throw new Error('listDepartments should not have been called');
    }),
    listDepartmentDirectory: jest.fn(async () => {
      throw new Error('listDepartmentDirectory should not have been called');
    }),
  };
}

describe('resolvePosition', () => {
  it('(a) an existing active assignment wins and makes no NPI call', async () => {
    const db = createFakeDb();
    const position = await db.position.create({
      data: { npiOrgId: 'org-1', roleKey: 'accountant', departmentId: null, titleAr: 'محاسب', personaAr: 'p' },
    });
    await db.positionAssignment.create({ data: { positionId: position.id, npiUserId: 'user-1' } });

    const npi = createUncalledNpi();
    const me = makeMe({ permissions: ['admin.department.manage'] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.source).toBe('assignment');
    expect(result.positionId).toBe(position.id);
    expect(result.departmentNameAr).toBeNull();
    expect(npi.listDepartments).not.toHaveBeenCalled();
    expect(npi.listDepartmentDirectory).not.toHaveBeenCalled();
  });

  it('(b) an assignment whose position has a different roleKey is ignored', async () => {
    const db = createFakeDb();
    const oldPosition = await db.position.create({
      data: { npiOrgId: 'org-1', roleKey: 'sales', departmentId: null, titleAr: 'مبيعات', personaAr: 'p' },
    });
    await db.positionAssignment.create({ data: { positionId: oldPosition.id, npiUserId: 'user-1' } });

    const npi: PositionsNpi = {
      listDepartments: jest.fn(async () => []),
      listDepartmentDirectory: jest.fn(async () => []),
    };
    // The user's NPI role is now "accountant", but their still-open
    // assignment is on the old "sales" position.
    const me = makeMe({ roleKey: 'accountant', permissions: [] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.source).toBe('role_only');
    expect(result.roleKey).toBe('accountant');
    expect(result.positionId).not.toBe(oldPosition.id);
    // The stale assignment is left exactly as it was (not ended, not moved).
    expect(db.assignments.find((a) => a.positionId === oldPosition.id)?.endedAt).toBeNull();
  });

  it('(b2) a stale assignment does not hide the current one on the next login', async () => {
    const db = createFakeDb();
    const oldPosition = await db.position.create({
      data: { npiOrgId: 'org-1', roleKey: 'sales', departmentId: null, titleAr: 'مبيعات', personaAr: 'p' },
    });
    await db.positionAssignment.create({ data: { positionId: oldPosition.id, npiUserId: 'user-1' } });
    const me = makeMe({ roleKey: 'accountant', permissions: [] });

    const first = await resolvePosition({ db, npi: createUncalledNpi() }, me);
    const second = await resolvePosition({ db, npi: createUncalledNpi() }, me);

    expect(first.source).toBe('role_only');
    expect(second.source).toBe('assignment');
    expect(second.positionId).toBe(first.positionId);
    expect(db.assignments.filter((a) => a.positionId === first.positionId)).toHaveLength(1);
  });

  it('(c) admin with a department in the directory resolves via npi_directory, creating the position and an assignment', async () => {
    const db = createFakeDb();
    const npi: PositionsNpi = {
      listDepartmentDirectory: jest.fn(async () => [{ id: 'user-1', departmentId: 'dept-1' }]),
      listDepartments: jest.fn(async () => [{ id: 'dept-1', code: 'FIN', nameAr: 'المالية', isActive: true }]),
    };
    const me = makeMe({ roleKey: 'admin', roleNameAr: 'مدير', permissions: ['admin.department.manage'] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.source).toBe('npi_directory');
    expect(result.departmentId).toBe('dept-1');
    expect(result.departmentNameAr).toBe('المالية');
    expect(result.titleAr).toBe('مدير — المالية');
    expect(db.positions).toHaveLength(1);
    expect(db.assignments).toHaveLength(1);
    expect(db.assignments[0].npiUserId).toBe('user-1');
  });

  it('(d) admin whose directory entry has departmentId: null resolves with no department but source npi_directory', async () => {
    const db = createFakeDb();
    const npi: PositionsNpi = {
      listDepartmentDirectory: jest.fn(async () => [{ id: 'user-1', departmentId: null }]),
      listDepartments: jest.fn(async () => []),
    };
    const me = makeMe({ roleKey: 'admin', roleNameAr: 'مدير', permissions: ['admin.department.manage'] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.source).toBe('npi_directory');
    expect(result.departmentId).toBeNull();
    expect(result.departmentNameAr).toBeNull();
    expect(npi.listDepartments).not.toHaveBeenCalled();
  });

  it('(e) a non-admin (no admin.department.manage) resolves role_only and calls neither NPI method', async () => {
    const db = createFakeDb();
    const npi = createUncalledNpi();
    const me = makeMe({ permissions: ['procurement.read'] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.source).toBe('role_only');
    expect(result.departmentId).toBeNull();
    expect(npi.listDepartments).not.toHaveBeenCalled();
    expect(npi.listDepartmentDirectory).not.toHaveBeenCalled();
  });

  it('(f) an NPI 403 on the directory call falls back to role_only', async () => {
    const db = createFakeDb();
    const npi: PositionsNpi = {
      listDepartmentDirectory: jest.fn(async () => {
        throw new NpiError({ status: 403, kind: 'forbidden', npiMessage: null });
      }),
      listDepartments: jest.fn(async () => []),
    };
    const me = makeMe({ permissions: ['admin.department.manage'] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.source).toBe('role_only');
    expect(result.departmentId).toBeNull();
  });

  it('(g) an NPI network error on the directory call falls back to role_only', async () => {
    const db = createFakeDb();
    const npi: PositionsNpi = {
      listDepartmentDirectory: jest.fn(async () => {
        throw new NpiError({ status: 0, kind: 'network', npiMessage: null, devDetail: 'fetch failed' });
      }),
      listDepartments: jest.fn(async () => []),
    };
    const me = makeMe({ permissions: ['admin.department.manage'] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.source).toBe('role_only');
    expect(result.departmentId).toBeNull();
  });

  it('(h) a non-NpiError thrown by the NPI fake is rethrown, not swallowed', async () => {
    const db = createFakeDb();
    const boom = new TypeError('totally unexpected');
    const npi: PositionsNpi = {
      listDepartmentDirectory: jest.fn(async () => {
        throw boom;
      }),
      listDepartments: jest.fn(async () => []),
    };
    const me = makeMe({ permissions: ['admin.department.manage'] });

    await expect(resolvePosition({ db, npi }, me)).rejects.toBe(boom);
  });

  it('(i) a second call for the same user reuses the position and creates no second assignment', async () => {
    const db = createFakeDb();
    const npi = createUncalledNpi();
    const me = makeMe({ permissions: [] });

    const first = await resolvePosition({ db, npi }, me);
    const second = await resolvePosition({ db, npi }, me);

    expect(second.positionId).toBe(first.positionId);
    expect(db.positions).toHaveLength(1);
    expect(db.assignments).toHaveLength(1);
  });

  it('(j) a create racing with a concurrent insert (P2002) re-reads and succeeds', async () => {
    const db = createFakeDb();
    let createCalls = 0;
    const originalCreate = db.position.create.bind(db.position);
    db.position.create = async (args) => {
      createCalls += 1;
      if (createCalls === 1) {
        const now = new Date();
        db.positions.push({
          id: 'pos-concurrent',
          npiOrgId: args.data.npiOrgId,
          roleKey: args.data.roleKey,
          departmentId: args.data.departmentId,
          titleAr: args.data.titleAr,
          personaAr: args.data.personaAr,
          createdAt: now,
          updatedAt: now,
        } as Position);
        throw { code: 'P2002' };
      }
      return originalCreate(args);
    };

    const npi = createUncalledNpi();
    const me = makeMe({ permissions: [] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.positionId).toBe('pos-concurrent');
    expect(createCalls).toBe(1);
    expect(db.assignments).toHaveLength(1);
  });

  it('(k) two users with the same role and department share one position and get one assignment each', async () => {
    const db = createFakeDb();
    const npi = createUncalledNpi();
    const me1 = makeMe({ id: 'user-1', permissions: [] });
    const me2 = makeMe({ id: 'user-2', permissions: [] });

    const r1 = await resolvePosition({ db, npi }, me1);
    const r2 = await resolvePosition({ db, npi }, me2);

    expect(r2.positionId).toBe(r1.positionId);
    expect(db.positions).toHaveLength(1);
    expect(db.assignments).toHaveLength(2);
    expect(db.assignments.map((a) => a.npiUserId).sort()).toEqual(['user-1', 'user-2']);
  });

  it('(l) a position of another organization with the same role is never returned', async () => {
    const db = createFakeDb();
    await db.position.create({
      data: { npiOrgId: 'org-OTHER', roleKey: 'accountant', departmentId: null, titleAr: 'محاسب', personaAr: 'p' },
    });

    const npi = createUncalledNpi();
    const me = makeMe({ organizationId: 'org-1', permissions: [] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.positionId).not.toBe(db.positions[0].id);
    expect(db.positions).toHaveLength(2);
    const mine = db.positions.find((p) => p.id === result.positionId);
    expect(mine?.npiOrgId).toBe('org-1');
  });

  it('(m) a malformed directory body is treated as an NpiError and falls back to role_only', async () => {
    const db = createFakeDb();
    const npi: PositionsNpi = {
      listDepartmentDirectory: jest.fn(async () => ({ not: 'an array' })),
      listDepartments: jest.fn(async () => []),
    };
    const me = makeMe({ permissions: ['admin.department.manage'] });

    const result = await resolvePosition({ db, npi }, me);

    expect(result.source).toBe('role_only');
    expect(result.departmentId).toBeNull();
  });
});

// Type-level check, enforced by `tsc`: the real Prisma client must satisfy
// the structural subset resolvePosition() asks for.
import type { PrismaClient } from '../src/generated/prisma';
import type { PositionsDb as PositionsDbContract } from '../src/positions/resolve';
export const _realClientSatisfiesPositionsDb = (client: PrismaClient): PositionsDbContract => client;
