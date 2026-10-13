// D-26 (T-48b): the preview card of the administrative flow — sections, rows,
// choices, the step, the before/after notes and the blockers. Pure: the
// resolution is built by hand, the way `resolveUserPermissions` returns it.
import { assessUserPermissions, type UserPermissionsOutput, type UserPermissionsValues } from '../src/extract/schemas/user_permissions';
import { t } from '../src/i18n/ar';
import { buildPreview, previewSteps } from '../src/intake/preview';
import { resolutionBlockers } from '../src/intake/resolution';
import type { EntityPick, FlowResolution, UserPermissionState } from '../src/intake/types';

type W = { value: string; confidence: number; evidence: string; page: number };
const f = (value: string | null, confidence = 1): W => ({ value: value ?? '', confidence, evidence: 'q', page: 0 });
const none = (): W => ({ value: '', confidence: 0, evidence: '', page: 0 });

const FLAGS = { ligatureSuspect: false, referenceDate: '2026-10-13' };
const REPORT = 'finance.report.read';
const INVOICE_READ = 'finance.invoice.read';
const INVOICE_WRITE = 'finance.invoice.write';

const output = (overrides: Partial<UserPermissionsOutput> = {}): UserPermissionsOutput => ({
  userName: f('أحمد الغامدي'),
  action: f('revoke'),
  permissions: [{ name: f('التقارير المالية') }],
  reason: none(),
  ...overrides,
});

const STATE: UserPermissionState = {
  roleAr: 'محاسب',
  rolePermissions: [REPORT, INVOICE_READ],
  overrides: [],
  effective: [REPORT, INVOICE_READ],
};

const LABELS = { [REPORT]: 'عرض التقارير المالية', [INVOICE_READ]: 'عرض الفواتير', [INVOICE_WRITE]: 'إصدار الفواتير والتحصيل' };

const matchedUser: EntityPick = { kind: 'matched', id: 'u-ahmad', labelAr: 'أحمد الغامدي', by: 'name' };
const matchedReport: EntityPick = { kind: 'matched', id: REPORT, labelAr: LABELS[REPORT], by: 'name' };

function resolution(overrides: Partial<FlowResolution> = {}): FlowResolution {
  return {
    flow: 'user_permissions',
    user: matchedUser,
    current: { 'u-ahmad': STATE },
    permissionLabels: LABELS,
    lines: [{ permission: matchedReport, warnings: [] }],
    warnings: [],
    notesAr: [t('preview.user_match', { name: 'أحمد الغامدي' })],
    ...overrides,
  };
}

function preview(out: UserPermissionsOutput, res: FlowResolution | null, choices: Record<string, string> = {}) {
  const { assessed, values } = assessUserPermissions(out, FLAGS);
  return buildPreview({ flow: 'user_permissions', assessed, values, resolution: res, choices, confirmed: [], hasDocument: false });
}

describe('buildPreview — user_permissions', () => {
  it('a clean revoke: the «التغيير» section, one permission row, the step, the before/after note, and approval is possible', () => {
    const { model } = preview(output({ reason: f('انتقل إلى قسم آخر') }), resolution());

    expect(model.flow).toBe('user_permissions');
    expect(model.flowLabelAr).toBe(t('flow.user_permissions'));
    expect(model.sections.map((s) => s.titleAr)).toEqual([t('preview.section.permission_change')]);
    expect(model.sections[0].fields.map((x) => x.path)).toEqual(['userName', 'action', 'reason']);
    expect(model.sections[0].fields.find((x) => x.path === 'action')?.displayAr).toBe(t('preview.enum.revoke'));

    expect(model.lines?.titleAr).toBe(t('preview.lines.permissions'));
    expect(model.lines?.rows.map((r) => r.titleAr)).toEqual([t('preview.permission_title', { n: 1 })]);
    expect(model.lines?.rows[0].fields.map((x) => x.path)).toEqual(['permissions.0.name']);

    expect(model.steps).toEqual([{ n: 1, labelAr: t('preview.step.permissions_set', { name: 'أحمد الغامدي', n: 1 }) }]);
    expect(model.notesAr).toContain(
      t('preview.permission_change', {
        label: LABELS[REPORT],
        before: t('preview.permission_via_role', { role: 'محاسب' }),
        after: t('preview.permission_denied'),
      }),
    );
    expect(model.choices).toEqual([]);
    expect(model.blockersAr).toEqual([]);
    expect(model.canApprove).toBe(true);
  });

  it('a request that changes nothing is a blocker, not an empty write', () => {
    const { model } = preview(output({ action: f('grant') }), resolution());
    expect(model.canApprove).toBe(false);
    expect(model.blockersAr).toEqual([
      t('preview.block.resolution', {
        reason: t('preview.permission_noop', { label: LABELS[REPORT], state: t('preview.permission_state.held') }),
      }),
    ]);
    expect(model.steps[0].labelAr).toBe(t('preview.step.permissions_set', { name: 'أحمد الغامدي', n: 0 }));
  });

  it('several permissions: only the changing ones get a before/after note and count in the step', () => {
    const { model } = preview(
      output({ permissions: [{ name: f('التقارير المالية') }, { name: f('عرض الفواتير') }] }),
      resolution({
        lines: [
          { permission: matchedReport, warnings: [] },
          { permission: { kind: 'matched', id: INVOICE_READ, labelAr: LABELS[INVOICE_READ], by: 'name' }, warnings: [] },
        ],
      }),
    );
    expect(model.lines?.rows).toHaveLength(2);
    expect(model.notesAr.filter((n) => n.includes('←'))).toHaveLength(2);
    expect(model.steps[0].labelAr).toBe(t('preview.step.permissions_set', { name: 'أحمد الغامدي', n: 2 }));
  });

  it('candidates for the user are a choice; until it is made the step shows the written name and approval is blocked', () => {
    const res = resolution({
      user: {
        kind: 'candidates',
        candidates: [
          { id: 'u-ahmad', labelAr: 'أحمد الغامدي — محاسب', similarity: 0.5 },
          { id: 'u-ahmad2', labelAr: 'أحمد القحطاني — مهندس', similarity: 0.4 },
        ],
      },
      current: { 'u-ahmad': STATE, 'u-ahmad2': { ...STATE, roleAr: 'مهندس' } },
    });
    const undecided = preview(output({ userName: f('أحمد') }), res).model;
    expect(undecided.choices).toEqual([
      {
        target: 'user',
        promptAr: t('preview.user_choose'),
        options: [
          { id: 'u-ahmad', labelAr: 'أحمد الغامدي — محاسب' },
          { id: 'u-ahmad2', labelAr: 'أحمد القحطاني — مهندس' },
        ],
        chosen: null,
      },
    ]);
    expect(undecided.canApprove).toBe(false);
    expect(undecided.blockersAr).toContain(t('preview.block.choice'));
    expect(undecided.steps[0].labelAr).toBe(t('preview.step.permissions_set', { name: 'أحمد', n: 0 }));
    // a user is never created: no «new» option
    expect(undecided.choices[0].options.some((o) => o.id === 'new')).toBe(false);

    const decided = preview(output({ userName: f('أحمد') }), res, { user: 'u-ahmad2' }).model;
    expect(decided.choices[0].chosen).toBe('u-ahmad2');
    expect(decided.canApprove).toBe(true);
    expect(decided.steps[0].labelAr).toBe(t('preview.step.permissions_set', { name: 'أحمد القحطاني — مهندس', n: 1 }));
  });

  it('candidate permissions are a choice per written name', () => {
    const res = resolution({
      lines: [
        {
          permission: {
            kind: 'candidates',
            candidates: [
              { id: INVOICE_READ, labelAr: LABELS[INVOICE_READ], similarity: 1 },
              { id: INVOICE_WRITE, labelAr: LABELS[INVOICE_WRITE], similarity: 1 },
            ],
          },
          warnings: [],
        },
      ],
    });
    const out = output({ permissions: [{ name: f('الفواتير') }] });
    const undecided = preview(out, res).model;
    expect(undecided.choices).toHaveLength(1);
    expect(undecided.choices[0]).toMatchObject({ target: 'permissions.0.key', promptAr: t('preview.permission_choose', { name: 'الفواتير' }), chosen: null });
    expect(undecided.canApprove).toBe(false);
    expect(undecided.steps[0].labelAr).toContain(t('preview.step.permissions_set', { name: 'أحمد الغامدي', n: 0 }));

    const decided = preview(out, res, { 'permissions.0.key': INVOICE_READ }).model;
    expect(decided.canApprove).toBe(true);
    expect(decided.notesAr.some((n) => n.startsWith(`${LABELS[INVOICE_READ]}:`))).toBe(true);
  });

  it('no user in the directory: a note and a blocker, and no «new» choice anywhere', () => {
    const res = resolution({ user: { kind: 'none' }, current: {}, notesAr: [t('preview.user_none', { name: 'أحمد الغامدي' })] });
    const { model } = preview(output(), res);
    expect(model.canApprove).toBe(false);
    expect(model.blockersAr).toContain(t('preview.block.resolution', { reason: t('preview.user_none', { name: 'أحمد الغامدي' }) }));
    expect(model.choices.some((c) => c.options.some((o) => o.id === 'new'))).toBe(false);
  });

  it('a permission NPI does not know is a blocker', () => {
    const res = resolution({ lines: [{ permission: { kind: 'none' }, warnings: [] }] });
    const { model } = preview(output({ permissions: [{ name: f('طيران') }] }), res);
    expect(model.canApprove).toBe(false);
    expect(model.blockersAr).toContain(t('preview.block.resolution', { reason: t('preview.permission_none', { name: 'طيران' }) }));
  });

  it('a user whose permissions could not be read keeps «اعتمد» disabled', () => {
    const res = resolution({ current: {} });
    const { model } = preview(output(), res);
    expect(model.canApprove).toBe(false);
    expect(model.blockersAr).toContain(t('preview.block.resolution', { reason: t('preview.user_permissions_unreadable') }));
  });

  it('an unreadable directory or catalog is the pick’s own message', () => {
    const unreadable: EntityPick = { kind: 'unreadable', messageAr: 'تعذر قراءة دليل الموظفين من NPI' };
    const res = resolution({ user: unreadable, lines: [{ permission: unreadable, warnings: [] }] });
    const { model } = preview(output(), res);
    expect(model.blockersAr.filter((b) => b.includes('تعذر قراءة دليل الموظفين'))).toHaveLength(2);
  });

  it('an incomplete extraction shows the flow’s own message and no steps', () => {
    const { model } = preview(output({ permissions: [] }), null);
    expect(model.incompleteAr).toBe(t('extract.incomplete.user_permissions'));
    expect(model.steps).toEqual([]);
    expect(model.canApprove).toBe(false);
  });

  it('the required paths are the user, the action and the permission name', () => {
    const { model } = preview(output({ userName: none() }), null);
    expect(model.blockersAr).toContain(t('preview.block.incomplete'));
    const fields = model.sections[0].fields;
    expect(fields.find((x) => x.path === 'userName')?.required).toBe(true);
    expect(fields.find((x) => x.path === 'reason')?.required).toBe(false);
  });
});

describe('previewSteps / resolutionBlockers — user_permissions', () => {
  const values: UserPermissionsValues = { userName: 'أحمد', action: 'revoke', permissions: [{ name: 'التقارير' }], reason: null };

  it('the step carries the written name while nothing is resolved', () => {
    expect(previewSteps('user_permissions', values, null, {})).toEqual([
      { n: 1, labelAr: t('preview.step.permissions_set', { name: 'أحمد', n: 0 }) },
    ]);
  });

  it('blockers are recomputed from the picks and the stored decisions', () => {
    expect(resolutionBlockers(resolution(), { userName: 'أحمد', permissions: values.permissions })).toEqual([]);
    expect(resolutionBlockers(resolution({ current: {} }), { userName: 'أحمد' })).toEqual([t('preview.user_permissions_unreadable')]);
    expect(resolutionBlockers(resolution({ user: { kind: 'none' } }), { userName: 'أحمد' })).toEqual([t('preview.user_none', { name: 'أحمد' })]);
  });
});
