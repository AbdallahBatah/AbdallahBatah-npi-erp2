// T-30 (F-13, BR-07): the reassignment service and the access rules, against
// the real local npi_copilot database with a fake NPI and a fake model. Every
// row written carries one of this run's organization ids and is deleted in
// afterAll (children first). The pure builder, the rendering and the narrative
// are in handover.spec.ts.
import path from 'node:path';

process.env.COPILOT_PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

import './helpers/load-env';
import { getDb } from '../src/db';
import { t } from '../src/i18n/ar';
import { LlmError } from '../src/llm/client';
import type { ModelResponse, RedactedRequest } from '../src/llm/provider';
import { NpiError } from '../src/npi/errors';
import { renderHandoverAr, type HandoverCaller, type HandoverNpi } from '../src/positions/handover';
import { HANDOVER_ADMIN_PERMISSION, HANDOVER_PERMISSION } from '../src/positions/handover-types';
import {
  HandoverError,
  activeHandoverFor,
  conversationReadableBy,
  getHandover,
  isHandoverAdmin,
  listCandidates,
  listHandovers,
  narrateHandover,
  parseHandoverBody,
  reassignPosition,
  type ReassignDb,
} from '../src/positions/reassign';
import { Pseudonymizer } from '../src/privacy/pseudonymizer';

const db = getDb();
const runId = Math.random().toString(36).slice(2, 10);
const orgIds: string[] = [];
let orgSeq = 0;

function newOrg(): string {
  orgSeq += 1;
  const id = `test-handover-${runId}-${orgSeq}`;
  orgIds.push(id);
  return id;
}

afterAll(async () => {
  const org = { in: orgIds };
  await db.memoryFact.deleteMany({ where: { npiOrgId: org } });
  await db.message.deleteMany({ where: { conversation: { npiOrgId: org } } });
  await db.conversation.deleteMany({ where: { npiOrgId: org } });
  await db.positionAssignment.deleteMany({ where: { position: { npiOrgId: org } } });
  await db.handoverDoc.deleteMany({ where: { position: { npiOrgId: org } } });
  await db.position.deleteMany({ where: { npiOrgId: org } });
  await db.llmAudit.deleteMany({ where: { npiOrgId: org } });
  await db.$disconnect();
});

// ─── The fake NPI ───────────────────────────────────────────────────────────

const T = (iso: string) => `${iso}T12:00:00.000Z`;
const NOW = new Date('2026-10-06T12:00:00.000Z');
const PM1_SINCE = new Date('2026-03-02T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const ROLES = [
  { id: 'role_pm', key: 'pm', nameAr: 'مدير المشاريع', nameEn: 'PM', permissions: [] },
  { id: 'role_acc', key: 'accountant', nameAr: 'المحاسب', nameEn: 'Acc', permissions: [] },
  { id: 'role_eng', key: 'site_engineer', nameAr: 'مهندس الموقع', nameEn: 'Eng', permissions: [] },
];
const DIRECTORY = [
  { id: 'u_admin', nameAr: 'مدير النظام', isActive: true, role: { key: 'admin' }, departmentId: null },
  { id: 'u_pm1', nameAr: 'سعد الحربي', isActive: true, role: { key: 'pm' }, departmentId: null },
  { id: 'u_pm2', nameAr: 'ماجد القحطاني', isActive: true, role: { key: 'pm' }, departmentId: null },
  { id: 'u_pm3', nameAr: 'عبدالله الدوسري', isActive: true, role: { key: 'pm' }, departmentId: null },
  { id: 'u_pm_off', nameAr: 'فهد المطيري', isActive: false, role: { key: 'pm' }, departmentId: null },
  { id: 'u_eng', nameAr: 'خالد العتيبي', isActive: true, role: { key: 'site_engineer' }, departmentId: null },
];

function wireStep(sequence: number, roleId: string) {
  return {
    sequence,
    status: 'PENDING',
    role: { id: roleId, nameAr: roleId, nameEn: roleId },
    decidedBy: null,
    decidedAt: null,
    note: null,
    escalatedAt: null,
  };
}
const HISTORY = {
  total: 2,
  rows: [
    {
      id: 'apr_pm',
      documentType: 'PURCHASE_REQUISITION',
      documentId: 'doc_1',
      documentCode: 'PR-00025',
      amount: 12800,
      status: 'PENDING',
      currentStep: 1,
      currentStepAt: T('2026-09-20'),
      createdAt: T('2026-09-19'),
      closedAt: null,
      raisedBy: { id: 'u_eng', nameAr: 'خالد العتيبي', nameEn: 'Khaled' },
      steps: [wireStep(1, 'role_pm')],
    },
    {
      id: 'apr_acc',
      documentType: 'PURCHASE_ORDER',
      documentId: 'doc_2',
      documentCode: 'PO-00007',
      amount: 98500,
      status: 'PENDING',
      currentStep: 1,
      currentStepAt: T('2026-09-22'),
      createdAt: T('2026-09-21'),
      closedAt: null,
      raisedBy: null,
      steps: [wireStep(1, 'role_acc')],
    },
  ],
};

function fakeNpi(o: Partial<Record<keyof HandoverNpi, () => Promise<unknown>>> = {}): HandoverNpi {
  return {
    listApprovalHistory: jest.fn(o.listApprovalHistory ?? (async () => HISTORY)),
    listRoles: jest.fn(o.listRoles ?? (async () => ROLES)),
    listDepartments: jest.fn(o.listDepartments ?? (async () => [])),
    listDepartmentDirectory: jest.fn(o.listDepartmentDirectory ?? (async () => DIRECTORY)),
    listVendors: jest.fn(o.listVendors ?? (async () => [])),
  } as unknown as HandoverNpi;
}

const GOOD_NARRATIVE = {
  summaryAr: 'يتولى هذا المنصب متابعة طلب الشراء المعلق والتنسيق مع الموردين.',
  firstWeekAr: ['ابدأ بالطلب PR-00025 فهو الأقدم.', 'تعرّف على الموردين المسجلين.', 'راجع الطلبات المعلقة كل أحد.'],
  cautionsAr: ['الاعتماد والرفض في صندوق وارد NPI فقط.'],
};

function fakeLlm(text = JSON.stringify(GOOD_NARRATIVE)) {
  const requests: RedactedRequest[] = [];
  return {
    requests,
    complete: jest.fn(async (req: RedactedRequest): Promise<ModelResponse> => {
      requests.push(req);
      return { text, toolCalls: [], stopReason: 'end_turn', tokensIn: 5, tokensOut: 5, modelId: 'test-model' };
    }),
  };
}
function failingLlm() {
  return { complete: jest.fn(async (): Promise<ModelResponse> => Promise.reject(new LlmError('timeout'))) };
}

function admin(orgId: string, permissions: readonly string[] = Object.values(HANDOVER_PERMISSION)): HandoverCaller {
  return { npiOrgId: orgId, npiUserId: 'u_admin', permissions };
}
function user(orgId: string, npiUserId: string): HandoverCaller {
  return { npiOrgId: orgId, npiUserId, permissions: ['scm.procurement.read'] };
}

// ─── Seeding ────────────────────────────────────────────────────────────────

interface Seed {
  orgId: string;
  /** pm, no department; pm1 holds it. */
  pm: { id: string };
  /** A second pm position (another department); pm2 holds it. */
  pm2: { id: string };
  /** site_engineer; eng holds it. */
  eng: { id: string };
  assignments: { pm1: string; pm2OnOther: string; eng: string };
}

async function seed(): Promise<Seed> {
  const orgId = newOrg();
  const mk = (roleKey: string, departmentId: string | null, titleAr: string) =>
    db.position.create({ data: { npiOrgId: orgId, roleKey, departmentId, titleAr, personaAr: 'x' }, select: { id: true } });
  const pm = await mk('pm', null, 'مدير المشاريع');
  const pm2 = await mk('pm', 'dep_2', 'مدير المشاريع — المشاريع');
  const eng = await mk('site_engineer', null, 'مهندس الموقع');
  const open = (positionId: string, npiUserId: string, startedAt: Date) =>
    db.positionAssignment.create({ data: { positionId, npiUserId, startedAt }, select: { id: true } });
  return {
    orgId,
    pm,
    pm2,
    eng,
    assignments: {
      pm1: (await open(pm.id, 'u_pm1', PM1_SINCE)).id,
      pm2OnOther: (await open(pm2.id, 'u_pm2', new Date('2026-05-01T12:00:00.000Z'))).id,
      eng: (await open(eng.id, 'u_eng', new Date('2026-04-01T12:00:00.000Z'))).id,
    },
  };
}

function deps(npi: HandoverNpi = fakeNpi(), llm: { complete: (req: RedactedRequest, ctx: never) => Promise<ModelResponse> } = fakeLlm()) {
  return {
    db: db as ReassignDb,
    npi,
    llm: llm as never,
    pseudonymizer: async () => new Pseudonymizer([]),
    now: () => NOW,
  };
}

/** The error a promise rejects with, or fails the test. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject');
}

async function expectRefused(promise: Promise<unknown>, code: HandoverError['code'], status: number, messageAr: string) {
  const err = await refusal(promise);
  expect(err).toBeInstanceOf(HandoverError);
  expect((err as HandoverError).code).toBe(code);
  expect((err as HandoverError).status).toBe(status);
  expect((err as HandoverError).messageAr).toBe(messageAr);
}

// ─── listCandidates ─────────────────────────────────────────────────────────

describe('listCandidates', () => {
  it('lists the active users of the position\'s role who do not hold it, by name; the holder is not a candidate', async () => {
    const s = await seed();
    const view = await listCandidates({ db, npi: fakeNpi() }, admin(s.orgId), s.pm.id);
    expect(view.position).toEqual({ id: s.pm.id, titleAr: 'مدير المشاريع', roleKey: 'pm' });
    expect(view.holders).toEqual([{ npiUserId: 'u_pm1', nameAr: 'سعد الحربي' }]);
    // pm2 holds the *other* pm position, so is a candidate here; pm1 (holder), pm_off (inactive),
    // eng (other role) and the admin are not.
    expect(view.candidates).toEqual(
      [
        { npiUserId: 'u_pm2', nameAr: 'ماجد القحطاني' },
        { npiUserId: 'u_pm3', nameAr: 'عبدالله الدوسري' },
      ].sort((a, b) => a.nameAr.localeCompare(b.nameAr, 'ar')),
    );
  });

  it('a holder the directory does not know has a null name', async () => {
    const s = await seed();
    await db.positionAssignment.create({ data: { positionId: s.pm.id, npiUserId: 'u_gone' } });
    const view = await listCandidates({ db, npi: fakeNpi() }, admin(s.orgId), s.pm.id);
    expect(view.holders).toContainEqual({ npiUserId: 'u_gone', nameAr: null });
  });

  it('is for an administrator only', async () => {
    const s = await seed();
    const npi = fakeNpi();
    await expectRefused(listCandidates({ db, npi }, user(s.orgId, 'u_pm2'), s.pm.id), 'forbidden', 403, t('handover.forbidden'));
    expect(npi.listDepartmentDirectory).not.toHaveBeenCalled();
    expect(isHandoverAdmin(admin(s.orgId))).toBe(true);
    expect(isHandoverAdmin(user(s.orgId, 'u_pm2'))).toBe(false);
    expect(HANDOVER_ADMIN_PERMISSION).toBe('admin.user.manage');
  });

  it('answers not_found for a position of another organization, or one that does not exist', async () => {
    const s = await seed();
    const other = newOrg();
    await expectRefused(listCandidates({ db, npi: fakeNpi() }, admin(other), s.pm.id), 'not_found', 404, t('handover.not_found'));
    await expectRefused(listCandidates({ db, npi: fakeNpi() }, admin(s.orgId), 'pos_missing'), 'not_found', 404, t('handover.not_found'));
  });

  it('names an unreadable directory: no permission, a 403, or any other NPI failure', async () => {
    const s = await seed();
    const noPermission = fakeNpi();
    await expectRefused(
      listCandidates({ db, npi: noPermission }, admin(s.orgId, [HANDOVER_ADMIN_PERMISSION]), s.pm.id),
      'npi',
      502,
      t('handover.directory_unreadable'),
    );
    expect(noPermission.listDepartmentDirectory).not.toHaveBeenCalled();

    const forbidden = fakeNpi({ listDepartmentDirectory: () => Promise.reject(new NpiError({ status: 403, kind: 'forbidden', npiMessage: null })) });
    await expectRefused(listCandidates({ db, npi: forbidden }, admin(s.orgId), s.pm.id), 'npi', 502, t('handover.directory_unreadable'));

    const timeout = new NpiError({ status: 0, kind: 'timeout', npiMessage: null });
    await expectRefused(
      listCandidates({ db, npi: fakeNpi({ listDepartmentDirectory: () => Promise.reject(timeout) }) }, admin(s.orgId), s.pm.id),
      'npi',
      502,
      timeout.messageAr,
    );
  });

  it('lets a 401 through as the NpiError it is (the route answers 401)', async () => {
    const s = await seed();
    const npi = fakeNpi({ listDepartmentDirectory: () => Promise.reject(new NpiError({ status: 401, kind: 'unauthorized', npiMessage: null })) });
    const err = await refusal(listCandidates({ db, npi }, admin(s.orgId), s.pm.id));
    expect(err).toBeInstanceOf(NpiError);
    expect((err as NpiError).kind).toBe('unauthorized');
  });
});

// ─── reassignPosition ───────────────────────────────────────────────────────

describe('reassignPosition', () => {
  it('writes the document, ends the predecessor and the successor\'s other same-role assignment, opens the successor\'s, and logs it', async () => {
    const s = await seed();
    const llm = fakeLlm();
    const npi = fakeNpi();
    const outcome = await reassignPosition(deps(npi, llm), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });

    // The document.
    const doc = await db.handoverDoc.findUniqueOrThrow({ where: { id: outcome.handoverId } });
    expect(doc.positionId).toBe(s.pm.id);
    expect(doc.fromUserId).toBe('u_pm1');
    expect(doc.toUserId).toBe('u_pm2');
    const body = parseHandoverBody(doc.bodyJson);
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(body.version).toBe(1);
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(body.position).toMatchObject({ id: s.pm.id, roleKey: 'pm', roleNameAr: 'مدير المشاريع', titleAr: 'مدير المشاريع' });
    expect(body.predecessor).toEqual({ npiUserId: 'u_pm1', nameAr: 'سعد الحربي', since: PM1_SINCE.toISOString() });
    expect(body.successor).toEqual({ npiUserId: 'u_pm2', nameAr: 'ماجد القحطاني' });
    // Only the chain waiting on pm, not the one waiting on the accountant.
    expect(body.tasks).toEqual({
      status: 'read',
      items: [
        {
          id: 'apr_pm',
          documentType: 'PURCHASE_REQUISITION',
          documentCode: 'PR-00025',
          amount: 12800,
          currentStep: 1,
          stepCount: 1,
          waitingSince: T('2026-09-20'),
          raisedByNameAr: 'خالد العتيبي',
          escalated: false,
        },
      ],
    });
    expect(body.narrative).toMatchObject({ status: 'written', ...GOOD_NARRATIVE, modelId: 'test-model' });
    expect(doc.bodyAr).toBe(renderHandoverAr(body));
    expect(doc.bodyAr).toContain('PR-00025');
    expect(doc.bodyAr).not.toContain('PO-00007');
    expect(outcome.narrativeStatus).toBe('written');

    // The assignments.
    const pm1 = await db.positionAssignment.findUniqueOrThrow({ where: { id: s.assignments.pm1 } });
    expect(pm1.endedAt?.toISOString()).toBe(NOW.toISOString());
    const pm2Other = await db.positionAssignment.findUniqueOrThrow({ where: { id: s.assignments.pm2OnOther } });
    expect(pm2Other.endedAt?.toISOString()).toBe(NOW.toISOString());
    const eng = await db.positionAssignment.findUniqueOrThrow({ where: { id: s.assignments.eng } });
    expect(eng.endedAt).toBeNull();
    const created = await db.positionAssignment.findUniqueOrThrow({ where: { id: outcome.assignmentId } });
    expect(created).toMatchObject({ positionId: s.pm.id, npiUserId: 'u_pm2', handoverDocId: doc.id, endedAt: null });
    expect(created.startedAt.toISOString()).toBe(NOW.toISOString());
    expect([...outcome.endedAssignmentIds].sort()).toEqual([s.assignments.pm1, s.assignments.pm2OnOther].sort());

    // One open assignment for each of them, so `resolvePosition` finds exactly one.
    expect(await db.positionAssignment.count({ where: { npiUserId: 'u_pm2', endedAt: null, position: { npiOrgId: s.orgId } } })).toBe(1);
    expect(await db.positionAssignment.count({ where: { positionId: s.pm.id, endedAt: null } })).toBe(1);

    // The model was asked once, on the advanced tier; the trust log has one row.
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(llm.requests[0]).toMatchObject({ tier: 'advanced', purpose: 'handover_narrative' });
    const audit = await db.llmAudit.findMany({ where: { npiOrgId: s.orgId, event: 'position_reassigned' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ npiUserId: 'u_admin', modelTier: null, modelId: null, tokensIn: 0, imageSent: false, error: null });
  });

  it('with no open holder there is no predecessor', async () => {
    const s = await seed();
    await db.positionAssignment.update({ where: { id: s.assignments.pm1 }, data: { endedAt: new Date('2026-06-01T00:00:00.000Z') } });
    const outcome = await reassignPosition(deps(), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });
    const doc = await db.handoverDoc.findUniqueOrThrow({ where: { id: outcome.handoverId } });
    expect(doc.fromUserId).toBeNull();
    expect(parseHandoverBody(doc.bodyJson)?.predecessor).toBeNull();
    expect(doc.bodyAr).not.toContain('من:');
    // The already-ended assignment is not ended again.
    expect(outcome.endedAssignmentIds).toEqual([s.assignments.pm2OnOther]);
  });

  it('with several open holders the predecessor is the latest to start, and all of them are ended', async () => {
    const s = await seed();
    const later = await db.positionAssignment.create({
      data: { positionId: s.pm.id, npiUserId: 'u_pm3', startedAt: new Date('2026-08-01T12:00:00.000Z') },
      select: { id: true },
    });
    const outcome = await reassignPosition(deps(), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });
    const doc = await db.handoverDoc.findUniqueOrThrow({ where: { id: outcome.handoverId } });
    expect(doc.fromUserId).toBe('u_pm3');
    expect(outcome.endedAssignmentIds).toEqual(expect.arrayContaining([s.assignments.pm1, later.id]));
    expect(await db.positionAssignment.count({ where: { positionId: s.pm.id, endedAt: null } })).toBe(1);
  });

  it('answers already_holder on a repeat, and not_candidate for another role, an inactive user, or someone NPI does not list', async () => {
    const s = await seed();
    const caller = admin(s.orgId);
    await reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId: 'u_pm2' });

    await expectRefused(
      reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId: 'u_pm2' }),
      'already_holder',
      409,
      t('handover.already_holder'),
    );
    for (const toUserId of ['u_eng', 'u_pm_off', 'u_nobody']) {
      await expectRefused(
        reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId }),
        'not_candidate',
        400,
        t('handover.not_candidate'),
      );
    }
    // The repeat and the refusals changed nothing: one document, one open holder.
    expect(await db.handoverDoc.count({ where: { positionId: s.pm.id } })).toBe(1);
    expect(await db.positionAssignment.count({ where: { positionId: s.pm.id, endedAt: null } })).toBe(1);
  });

  it('refuses a non-administrator, and a position of another organization, without calling the model', async () => {
    const s = await seed();
    const llm = fakeLlm();
    await expectRefused(
      reassignPosition(deps(fakeNpi(), llm), user(s.orgId, 'u_pm2'), { positionId: s.pm.id, toUserId: 'u_pm2' }),
      'forbidden',
      403,
      t('handover.forbidden'),
    );
    await expectRefused(
      reassignPosition(deps(fakeNpi(), llm), admin(newOrg()), { positionId: s.pm.id, toUserId: 'u_pm2' }),
      'not_found',
      404,
      t('handover.not_found'),
    );
    expect(llm.complete).not.toHaveBeenCalled();
    expect(await db.handoverDoc.count({ where: { positionId: s.pm.id } })).toBe(0);
    expect(await db.positionAssignment.count({ where: { positionId: s.pm.id, endedAt: null } })).toBe(1);
  });

  it('a failing model still creates the document, with a failed narrative the administrator can retry', async () => {
    const s = await seed();
    const outcome = await reassignPosition(deps(fakeNpi(), failingLlm()), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });
    expect(outcome.narrativeStatus).toBe('failed');
    const doc = await db.handoverDoc.findUniqueOrThrow({ where: { id: outcome.handoverId } });
    expect(parseHandoverBody(doc.bodyJson)?.narrative).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(doc.bodyAr).not.toContain('ملخص الاستلام');
    // The reassignment itself went through.
    expect(await db.positionAssignment.count({ where: { positionId: s.pm.id, npiUserId: 'u_pm2', endedAt: null } })).toBe(1);
  });

  it('an unreadable approval history leaves the tasks skipped in the document, and the reassignment goes through', async () => {
    const s = await seed();
    const npi = fakeNpi({ listApprovalHistory: () => Promise.reject(new NpiError({ status: 403, kind: 'forbidden', npiMessage: null })) });
    const outcome = await reassignPosition(deps(npi), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });
    const doc = await db.handoverDoc.findUniqueOrThrow({ where: { id: outcome.handoverId } });
    expect(parseHandoverBody(doc.bodyJson)?.tasks).toEqual({ status: 'skipped', reason: 'npi_refused' });
    expect(doc.bodyAr).toContain('تعذر قراءة المهام من NPI: رفض NPI القراءة');
  });

  it('two reassignments to the same person at once leave exactly one open assignment', async () => {
    const s = await seed();
    const results = await Promise.allSettled([
      reassignPosition(deps(), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' }),
      reassignPosition(deps(), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.positionAssignment.count({ where: { positionId: s.pm.id, npiUserId: 'u_pm2', endedAt: null } })).toBe(1);
    expect(await db.handoverDoc.count({ where: { positionId: s.pm.id } })).toBe(1);
  });

  it('hands the position back: the previous successor becomes the predecessor of the second document', async () => {
    const s = await seed();
    const caller = admin(s.orgId);
    const first = await reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId: 'u_pm2' });
    const second = await reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId: 'u_pm1' });
    const doc = await db.handoverDoc.findUniqueOrThrow({ where: { id: second.handoverId } });
    expect(doc.fromUserId).toBe('u_pm2');
    expect(doc.toUserId).toBe('u_pm1');
    expect(second.endedAssignmentIds).toEqual([first.assignmentId]);
    expect(await db.positionAssignment.count({ where: { positionId: s.pm.id, endedAt: null } })).toBe(1);
  });
});

// ─── narrateHandover ────────────────────────────────────────────────────────

describe('narrateHandover', () => {
  it('turns a failed narrative into a written one from the stored body, and stores it', async () => {
    const s = await seed();
    const caller = admin(s.orgId);
    const outcome = await reassignPosition(deps(fakeNpi(), failingLlm()), caller, { positionId: s.pm.id, toUserId: 'u_pm2' });
    expect(outcome.narrativeStatus).toBe('failed');

    const npi = fakeNpi();
    const llm = fakeLlm();
    const view = await narrateHandover({ ...deps(npi, llm) }, caller, outcome.handoverId);
    expect(view.id).toBe(outcome.handoverId);
    expect(view.narrativeStatus).toBe('written');
    expect(view.body.narrative).toMatchObject({ status: 'written', summaryAr: GOOD_NARRATIVE.summaryAr });
    expect(view.bodyAr).toContain('ملخص الاستلام');
    expect(view.bodyAr).toContain(GOOD_NARRATIVE.summaryAr);
    expect(view.predecessorConversations).toEqual([]);
    // From the stored body: no NPI read at all.
    for (const call of Object.values(npi)) expect(call).not.toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalledTimes(1);

    const stored = await db.handoverDoc.findUniqueOrThrow({ where: { id: outcome.handoverId } });
    expect(parseHandoverBody(stored.bodyJson)?.narrative.status).toBe('written');
    expect(stored.bodyAr).toBe(view.bodyAr);
    // Nothing else in the body moved.
    expect(parseHandoverBody(stored.bodyJson)?.tasks).toMatchObject({ status: 'read' });
  });

  it('keeps a failed narrative failed when the model fails again', async () => {
    const s = await seed();
    const caller = admin(s.orgId);
    const outcome = await reassignPosition(deps(fakeNpi(), failingLlm()), caller, { positionId: s.pm.id, toUserId: 'u_pm2' });
    const view = await narrateHandover(deps(fakeNpi(), failingLlm()), caller, outcome.handoverId);
    expect(view.body.narrative).toMatchObject({ status: 'failed', reason: 'timeout' });
  });

  it('is for an administrator of the document\'s organization only', async () => {
    const s = await seed();
    const outcome = await reassignPosition(deps(), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });
    const llm = fakeLlm();
    await expectRefused(narrateHandover(deps(fakeNpi(), llm), user(s.orgId, 'u_pm2'), outcome.handoverId), 'forbidden', 403, t('handover.forbidden'));
    await expectRefused(narrateHandover(deps(fakeNpi(), llm), admin(newOrg()), outcome.handoverId), 'not_found', 404, t('handover.not_found'));
    await expectRefused(narrateHandover(deps(fakeNpi(), llm), admin(s.orgId), 'doc_missing'), 'not_found', 404, t('handover.not_found'));
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('treats a stored body that is not version 1 as not found', async () => {
    const s = await seed();
    const doc = await db.handoverDoc.create({
      data: { positionId: s.pm.id, fromUserId: 'u_pm1', toUserId: 'u_pm2', bodyJson: { version: 2 }, bodyAr: 'x' },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expectRefused(narrateHandover(deps(), admin(s.orgId), doc.id), 'not_found', 404, t('handover.not_found'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(doc.id));
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── Reading documents: who sees what ───────────────────────────────────────

describe('listHandovers / getHandover', () => {
  it('an administrator sees every document of the organization, the successor and the predecessor see theirs, anyone else sees nothing', async () => {
    const s = await seed();
    const caller = admin(s.orgId);
    const a = await reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId: 'u_pm2' });
    // A second document in the same organization about other people: the engineer's position
    // handed from u_eng to u_pm3 (written directly; the engineer role has no other candidate here).
    const engDoc = await db.handoverDoc.create({
      data: {
        positionId: s.eng.id,
        fromUserId: 'u_eng',
        toUserId: 'u_pm3',
        bodyJson: parseHandoverBody((await db.handoverDoc.findUniqueOrThrow({ where: { id: a.handoverId } })).bodyJson) as never,
        bodyAr: 'x',
      },
    });

    const adminList = await listHandovers({ db }, caller);
    expect(adminList.map((d) => d.id).sort()).toEqual([a.handoverId, engDoc.id].sort());

    const pm2List = await listHandovers({ db }, user(s.orgId, 'u_pm2'));
    expect(pm2List.map((d) => d.id)).toEqual([a.handoverId]);
    expect(pm2List[0]).toMatchObject({
      positionId: s.pm.id,
      positionTitleAr: 'مدير المشاريع',
      fromUserId: 'u_pm1',
      toUserId: 'u_pm2',
      narrativeStatus: 'written',
    });
    expect(Date.parse(pm2List[0].createdAt)).not.toBeNaN();

    expect((await listHandovers({ db }, user(s.orgId, 'u_pm1'))).map((d) => d.id)).toEqual([a.handoverId]);
    expect((await listHandovers({ db }, user(s.orgId, 'u_eng'))).map((d) => d.id)).toEqual([engDoc.id]);
    expect(await listHandovers({ db }, user(s.orgId, 'u_pm3'))).toHaveLength(1);
    expect(await listHandovers({ db }, user(s.orgId, 'u_nobody'))).toEqual([]);
    // Another organization sees nothing, administrator or not.
    expect(await listHandovers({ db }, admin(newOrg()))).toEqual([]);

    expect((await getHandover({ db }, user(s.orgId, 'u_pm2'), a.handoverId))?.id).toBe(a.handoverId);
    expect((await getHandover({ db }, user(s.orgId, 'u_pm1'), a.handoverId))?.id).toBe(a.handoverId);
    expect((await getHandover({ db }, caller, a.handoverId))?.id).toBe(a.handoverId);
    expect(await getHandover({ db }, user(s.orgId, 'u_eng'), a.handoverId)).toBeNull();
    expect(await getHandover({ db }, user(s.orgId, 'u_nobody'), a.handoverId)).toBeNull();
    expect(await getHandover({ db }, admin(newOrg()), a.handoverId)).toBeNull();
    expect(await getHandover({ db }, caller, 'doc_missing')).toBeNull();
  });

  it('lists newest first and at most 100', async () => {
    const s = await seed();
    const body = {
      version: 1,
      generatedAt: T('2026-10-06'),
      position: { id: s.pm.id, roleKey: 'pm', roleNameAr: null, departmentId: null, departmentNameAr: null, titleAr: 'مدير المشاريع' },
      predecessor: null,
      successor: { npiUserId: 'u_pm2', nameAr: null },
      tasks: { status: 'read', items: [] },
      vendors: [],
      routines: [],
      companyFacts: [],
      narrative: { status: 'skipped' },
    };
    await db.handoverDoc.createMany({
      data: Array.from({ length: 105 }, (_, i) => ({
        positionId: s.pm.id,
        fromUserId: null,
        toUserId: 'u_pm2',
        bodyJson: body,
        bodyAr: 'x',
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
      })),
    });
    const list = await listHandovers({ db }, admin(s.orgId));
    expect(list).toHaveLength(100);
    const times = list.map((d) => Date.parse(d.createdAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(list[0].narrativeStatus).toBe('skipped');
  });

  it('gives an administrator the predecessor\'s conversations of that position — newest first, with message counts — and no one else', async () => {
    const s = await seed();
    const caller = admin(s.orgId);
    const mkConversation = async (npiUserId: string, positionId: string | null, titleAr: string | null, updatedAt: string, messages: number) => {
      const conversation = await db.conversation.create({
        data: { npiOrgId: s.orgId, npiUserId, positionId, titleAr, updatedAt: new Date(updatedAt) },
        select: { id: true },
      });
      for (let i = 0; i < messages; i += 1) {
        await db.message.create({ data: { conversationId: conversation.id, role: i % 2 === 0 ? 'user' : 'assistant', contentAr: `رسالة ${i}` } });
      }
      return conversation.id;
    };
    const older = await mkConversation('u_pm1', s.pm.id, 'تسليم الموقع الشمالي', '2026-09-01T00:00:00.000Z', 2);
    const newer = await mkConversation('u_pm1', s.pm.id, null, '2026-09-20T00:00:00.000Z', 3);
    await mkConversation('u_pm1', s.pm2.id, 'منصب آخر', '2026-09-25T00:00:00.000Z', 1);
    await mkConversation('u_pm1', null, 'بلا منصب', '2026-09-26T00:00:00.000Z', 1);
    await mkConversation('u_pm2', s.pm.id, 'محادثة الخلف', '2026-09-27T00:00:00.000Z', 1);

    const outcome = await reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId: 'u_pm2' });
    // updatedAt is set by the client at creation; touch nothing else.
    const adminView = await getHandover({ db }, caller, outcome.handoverId);
    expect(adminView?.predecessorConversations).toEqual([
      { id: newer, titleAr: null, updatedAt: '2026-09-20T00:00:00.000Z', messageCount: 3 },
      { id: older, titleAr: 'تسليم الموقع الشمالي', updatedAt: '2026-09-01T00:00:00.000Z', messageCount: 2 },
    ]);

    const successorView = await getHandover({ db }, user(s.orgId, 'u_pm2'), outcome.handoverId);
    expect(successorView).not.toBeNull();
    expect('predecessorConversations' in (successorView ?? {})).toBe(false);
    const predecessorView = await getHandover({ db }, user(s.orgId, 'u_pm1'), outcome.handoverId);
    expect('predecessorConversations' in (predecessorView ?? {})).toBe(false);
  });

  it('a stored body that is not version 1 is left out of the list and is not found, with a warning naming the id', async () => {
    const s = await seed();
    const good = await reassignPosition(deps(), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });
    const bad = await db.handoverDoc.create({
      data: { positionId: s.pm.id, fromUserId: 'u_pm1', toUserId: 'u_pm2', bodyJson: { version: 2, anything: true }, bodyAr: 'x' },
    });
    const malformed = await db.handoverDoc.create({
      data: { positionId: s.pm.id, fromUserId: 'u_pm1', toUserId: 'u_pm2', bodyJson: { version: 1 }, bodyAr: 'x' },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const list = await listHandovers({ db }, admin(s.orgId));
      expect(list.map((d) => d.id)).toEqual([good.handoverId]);
      expect(await getHandover({ db }, admin(s.orgId), bad.id)).toBeNull();
      expect(await getHandover({ db }, admin(s.orgId), malformed.id)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(bad.id));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(malformed.id));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parseHandoverBody', () => {
  it('accepts what a reassignment stores and nothing that is not a version 1 body', async () => {
    const s = await seed();
    const outcome = await reassignPosition(deps(), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });
    const doc = await db.handoverDoc.findUniqueOrThrow({ where: { id: outcome.handoverId } });
    const body = parseHandoverBody(doc.bodyJson);
    expect(body).not.toBeNull();
    expect(parseHandoverBody({ ...(body as object), version: 2 })).toBeNull();
    expect(parseHandoverBody({ ...(body as object), narrative: { status: 'unknown' } })).toBeNull();
    expect(parseHandoverBody({ ...(body as object), tasks: { status: 'read', items: [{ id: 'a', amount: '12' }] } })).toBeNull();
    expect(parseHandoverBody(null)).toBeNull();
    expect(parseHandoverBody('x')).toBeNull();
  });
});

// ─── conversationReadableBy (BR-07) ─────────────────────────────────────────

describe('conversationReadableBy', () => {
  it('the owner always; an administrator only once the owner is a predecessor of that conversation\'s position; nobody else', async () => {
    const s = await seed();
    const caller = admin(s.orgId);
    const mk = async (npiUserId: string, positionId: string | null) =>
      (await db.conversation.create({ data: { npiOrgId: s.orgId, npiUserId, positionId }, select: { id: true } })).id;
    const pm1OnPm = await mk('u_pm1', s.pm.id);
    const pm1OnOther = await mk('u_pm1', s.pm2.id);
    const pm1NoPosition = await mk('u_pm1', null);
    const pm2OnPm = await mk('u_pm2', s.pm.id);

    // Before any handover the administrator may not read anybody's chat (BR-07).
    expect(await conversationReadableBy(db, caller, pm1OnPm)).toBeNull();
    expect(await conversationReadableBy(db, user(s.orgId, 'u_pm1'), pm1OnPm)).toEqual({ id: pm1OnPm });

    await reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId: 'u_pm2' });

    // Owner: yes, everywhere.
    for (const id of [pm1OnPm, pm1OnOther, pm1NoPosition]) {
      expect(await conversationReadableBy(db, user(s.orgId, 'u_pm1'), id)).toEqual({ id });
    }
    expect(await conversationReadableBy(db, user(s.orgId, 'u_pm2'), pm2OnPm)).toEqual({ id: pm2OnPm });
    // Administrator: pm1 is now a predecessor of the pm position — yes there; no on another position,
    // no on a position-less conversation, no on the successor's own chat.
    expect(await conversationReadableBy(db, caller, pm1OnPm)).toEqual({ id: pm1OnPm });
    expect(await conversationReadableBy(db, caller, pm1OnOther)).toBeNull();
    expect(await conversationReadableBy(db, caller, pm1NoPosition)).toBeNull();
    expect(await conversationReadableBy(db, caller, pm2OnPm)).toBeNull();
    // The successor reads none of the predecessor's chats; neither does a colleague.
    expect(await conversationReadableBy(db, user(s.orgId, 'u_pm2'), pm1OnPm)).toBeNull();
    expect(await conversationReadableBy(db, user(s.orgId, 'u_eng'), pm1OnPm)).toBeNull();
    // An administrator of another organization reads nothing; a missing id is null.
    expect(await conversationReadableBy(db, admin(newOrg()), pm1OnPm)).toBeNull();
    expect(await conversationReadableBy(db, caller, 'conv_missing')).toBeNull();
  });

  it('a user with the admin permission who is the owner reads their own, and an administrator is not a reader of a non-predecessor\'s chat', async () => {
    const s = await seed();
    const mine = (await db.conversation.create({ data: { npiOrgId: s.orgId, npiUserId: 'u_admin', positionId: null }, select: { id: true } })).id;
    expect(await conversationReadableBy(db, admin(s.orgId), mine)).toEqual({ id: mine });
    const theirs = (await db.conversation.create({ data: { npiOrgId: s.orgId, npiUserId: 'u_eng', positionId: s.eng.id }, select: { id: true } })).id;
    expect(await conversationReadableBy(db, admin(s.orgId), theirs)).toBeNull();
  });
});

// ─── activeHandoverFor ──────────────────────────────────────────────────────

describe('activeHandoverFor', () => {
  it('finds the document within seven days of the takeover and not after', async () => {
    const s = await seed();
    const outcome = await reassignPosition(deps(), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });
    const me = { npiUserId: 'u_pm2', positionId: s.pm.id };

    const day6 = await activeHandoverFor(db, me, new Date(NOW.getTime() + 6 * DAY));
    expect(day6?.version).toBe(1);
    expect(day6?.successor.npiUserId).toBe('u_pm2');
    expect(day6?.narrative.status).toBe('written');
    const stored = await db.handoverDoc.findUniqueOrThrow({ where: { id: outcome.handoverId } });
    expect(day6).toEqual(parseHandoverBody(stored.bodyJson));

    expect(await activeHandoverFor(db, me, new Date(NOW.getTime() + 7 * DAY))).not.toBeNull();
    expect(await activeHandoverFor(db, me, new Date(NOW.getTime() + 7 * DAY + 1))).toBeNull();
    expect(await activeHandoverFor(db, me, new Date(NOW.getTime() + 8 * DAY))).toBeNull();
  });

  it('is null for anyone else, for another position, and for a position that was never handed over', async () => {
    const s = await seed();
    await reassignPosition(deps(), admin(s.orgId), { positionId: s.pm.id, toUserId: 'u_pm2' });
    const soon = new Date(NOW.getTime() + DAY);
    // The predecessor, whose assignment ended.
    expect(await activeHandoverFor(db, { npiUserId: 'u_pm1', positionId: s.pm.id }, soon)).toBeNull();
    // The successor's other position: that assignment ended and carries no document.
    expect(await activeHandoverFor(db, { npiUserId: 'u_pm2', positionId: s.pm2.id }, soon)).toBeNull();
    // A position nobody handed over: the engineer's own assignment has no document.
    expect(await activeHandoverFor(db, { npiUserId: 'u_eng', positionId: s.eng.id }, soon)).toBeNull();
    expect(await activeHandoverFor(db, { npiUserId: 'u_nobody', positionId: s.pm.id }, soon)).toBeNull();
  });

  it('is null once the successor has handed the position on, and the next holder gets the second document', async () => {
    const s = await seed();
    const caller = admin(s.orgId);
    await reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId: 'u_pm2' });
    await reassignPosition(deps(), caller, { positionId: s.pm.id, toUserId: 'u_pm3' });
    const soon = new Date(NOW.getTime() + DAY);
    expect(await activeHandoverFor(db, { npiUserId: 'u_pm2', positionId: s.pm.id }, soon)).toBeNull();
    const next = await activeHandoverFor(db, { npiUserId: 'u_pm3', positionId: s.pm.id }, soon);
    expect(next?.predecessor?.npiUserId).toBe('u_pm2');
  });

  it('is null, with a warning, when the stored body is not a version 1 document', async () => {
    const s = await seed();
    const doc = await db.handoverDoc.create({
      data: { positionId: s.pm.id, fromUserId: 'u_pm1', toUserId: 'u_pm2', bodyJson: { version: 2 }, bodyAr: 'x' },
    });
    await db.positionAssignment.create({
      data: { positionId: s.pm.id, npiUserId: 'u_pm2', startedAt: NOW, handoverDocId: doc.id },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await activeHandoverFor(db, { npiUserId: 'u_pm2', positionId: s.pm.id }, NOW)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(doc.id));
    } finally {
      warn.mockRestore();
    }
  });
});
