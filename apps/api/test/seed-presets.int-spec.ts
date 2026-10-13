/**
 * P1-13 — the seed's default is the company's seven roles and five approval rules.
 *
 * Owner decision of 2026-10-12: packages/db/prisma/seed.ts writes ROLE_PRESETS
 * and PROPOSED_APPROVAL_RULES (packages/shared/src/presets.ts) as they are, so
 * a fresh database (and the demo server after its nightly reset) opens
 * /admin/presets with every card and every rule «مطابق» and nobody applies
 * anything by hand. This suite asks the real RolePresetsService for that same
 * preview (GET /admin/role-presets) over the seeded organization, as the
 * seeded administrator. Read only: nothing is written.
 *
 * Not part of `npm test` — see jest.integration.config.js. Needs the seeded
 * local database: `npm run db:seed`, then `npm run test:int -- seed-presets`.
 * On a database seeded before P1-13 it fails and names what differs.
 */
import { PROPOSED_APPROVAL_RULES, ROLE_PRESETS } from '@npi/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/common/audit.service';
import { EffectivePermissionsService } from '../src/common/effective-permissions.service';
import { AdminService } from '../src/modules/admin/admin.service';
import { ApprovalRulesService } from '../src/modules/approvals/approvals.service';
import { RolePresetsService, type PresetsOverview } from '../src/modules/admin/role-presets.service';
import { authUserFor } from './support/proposal-stack';

const prisma = new PrismaService();
const audit = new AuditService(prisma);
const presets = new RolePresetsService(
  prisma,
  audit,
  new AdminService(prisma, audit, new EffectivePermissionsService(prisma)),
  new ApprovalRulesService(prisma, audit),
);

/** The seeded login of each preset's role (seed.ts `userDefs`). */
const SEEDED_LOGIN: Record<string, string> = {
  executive: 'ceo@npi.sa',
  pm: 'pm@npi.sa',
  technical_office: 'tech@npi.sa',
  site_engineer: 'engineer@npi.sa',
  finance_manager: 'finance@npi.sa',
  accountant: 'accountant@npi.sa',
  warehouse_keeper: 'store@npi.sa',
};

let overview: PresetsOverview;

beforeAll(async () => {
  overview = await presets.overview(await authUserFor(prisma, 'admin@npi.sa'));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the seeded organization against the presets page (P1-13)', () => {
  it('reads every one of the seven role presets as «same»', () => {
    const status = Object.fromEntries(
      overview.presets.map((p) => [p.key, { status: p.status, added: p.added, removed: p.removed, renamed: p.renamed }]),
    );
    expect(status).toEqual(
      Object.fromEntries(
        ROLE_PRESETS.map((p) => [p.key, { status: 'same', added: [], removed: [], renamed: false }]),
      ),
    );
  });

  it('gives each preset role its one seeded login, and nothing blocks', () => {
    for (const p of overview.presets) {
      expect({ key: p.key, users: p.affectedUsers.map((u) => u.email), blockedBy: p.blockedBy }).toEqual({
        key: p.key,
        users: [SEEDED_LOGIN[p.key]],
        blockedBy: [],
      });
    }
  });

  it('reads every one of the five proposed approval rules as «same»: one active rule from zero with the chain', () => {
    expect(overview.rules.map((r) => ({ documentType: r.documentType, status: r.status }))).toEqual(
      PROPOSED_APPROVAL_RULES.map((r) => ({ documentType: r.documentType, status: 'same' })),
    );
    for (const r of overview.rules) {
      const proposed = PROPOSED_APPROVAL_RULES.find((p) => p.documentType === r.documentType)!;
      expect(r.current).toHaveLength(1);
      expect(r.current[0]).toMatchObject({ minAmount: 0, maxAmount: null });
      expect(r.current[0].steps.map((s) => s.key)).toEqual([...proposed.steps]);
    }
  });
});
