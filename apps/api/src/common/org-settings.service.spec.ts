/**
 * CRM Phase 1 · Step 4 (contract §4) — the settings an administrator may edit from
 * the screen: the default validity of a proposal, the age at which a cost is warned
 * about, and (Step 2) the name-similarity threshold. Everything else in `OrgSetting`
 * (for instance the merge master switch) stays out of reach of the endpoint.
 */
import { BadRequestException } from '@nestjs/common';
import { ORG_SETTING_DEFAULTS, ORG_SETTING_EDITABLE, ORG_SETTING_KEYS, OrgSettingsService } from './org-settings.service';

function setup(rows: Array<{ key: string; valueJson: unknown }> = []) {
  const tx = {
    orgSetting: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(async ({ create }: { create: { key: string; valueJson: unknown } }) => ({ id: `s-${create.key}`, ...create })),
    },
  };
  const prisma = {
    orgSetting: { ...tx.orgSetting, findMany: jest.fn().mockResolvedValue(rows) },
    $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new OrgSettingsService(prisma as never, audit as never), prisma, tx, audit };
}

describe('the proposal settings and their defaults', () => {
  it('has the two Step 4 keys, both defaulting to 30 days', () => {
    expect(ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS).toBe('crm.proposal.validityDays');
    expect(ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS).toBe('crm.proposal.costAgeWarnDays');
    expect(ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS]).toBe(30);
    expect(ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS]).toBe(30);
  });

  it('lists exactly the six editable keys (Step 5 added the two task-reminder ones, P3-6 the margin floor) — the merge switch is not among them', () => {
    expect(Object.keys(ORG_SETTING_EDITABLE).sort()).toEqual(
      [
        ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD,
        ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS,
        ORG_SETTING_KEYS.PROPOSAL_MIN_MARGIN_PCT,
        ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS,
        ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE,
        ORG_SETTING_KEYS.TASK_REMINDER_HOUR,
      ].sort(),
    );
    expect(Object.keys(ORG_SETTING_EDITABLE)).not.toContain(ORG_SETTING_KEYS.CUSTOMER_MERGE_ENABLED);
  });
});

describe('the follow-up task settings (Step 5)', () => {
  it('has the two keys, defaulting to 1 day before and 08:00 Riyadh', () => {
    expect(ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE).toBe('crm.task.reminderDaysBefore');
    expect(ORG_SETTING_KEYS.TASK_REMINDER_HOUR).toBe('crm.task.reminderHour');
    expect(ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE]).toBe(1);
    expect(ORG_SETTING_DEFAULTS[ORG_SETTING_KEYS.TASK_REMINDER_HOUR]).toBe(8);
  });

  it.each([
    [ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE, -1],
    [ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE, 31],
    [ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE, 1.5],
    [ORG_SETTING_KEYS.TASK_REMINDER_HOUR, -1],
    [ORG_SETTING_KEYS.TASK_REMINDER_HOUR, 24],
    [ORG_SETTING_KEYS.TASK_REMINDER_HOUR, '8'],
  ])('refuses %s = %p as out of range (400)', async (key, value) => {
    const { svc, tx } = setup();
    await expect(svc.setEditable('org1', { [key]: value } as never, 'admin1')).rejects.toThrow(
      new BadRequestException('Setting value out of range'),
    );
    expect(tx.orgSetting.upsert).not.toHaveBeenCalled();
  });

  it('accepts the edges: 0 and 30 days, hour 0 and 23', async () => {
    const { svc } = setup();
    await expect(
      svc.setEditable(
        'org1',
        { [ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE]: 0, [ORG_SETTING_KEYS.TASK_REMINDER_HOUR]: 23 },
        'admin1',
      ),
    ).resolves.toBeUndefined();
    await expect(
      svc.setEditable(
        'org1',
        { [ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE]: 30, [ORG_SETTING_KEYS.TASK_REMINDER_HOUR]: 0 },
        'admin1',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('OrgSettingsService.getEditable', () => {
  it('returns every editable key, the stored value or else the default', async () => {
    const { svc } = setup([{ key: ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS, valueJson: 45 }]);
    await expect(svc.getEditable('org1')).resolves.toEqual({
      [ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS]: 45,
      [ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS]: 30,
      [ORG_SETTING_KEYS.PROPOSAL_MIN_MARGIN_PCT]: 15,
      [ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD]: 0.8,
      [ORG_SETTING_KEYS.TASK_REMINDER_DAYS_BEFORE]: 1,
      [ORG_SETTING_KEYS.TASK_REMINDER_HOUR]: 8,
    });
  });

  it('a stored value of the wrong type falls back to the default', async () => {
    const { svc } = setup([{ key: ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS, valueJson: 'soon' }]);
    expect((await svc.getEditable('org1'))[ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS]).toBe(30);
  });
});

describe('OrgSettingsService.setEditable', () => {
  it('writes the given keys in one transaction, each audited with its before / after', async () => {
    const { svc, tx, audit, prisma } = setup();
    await svc.setEditable(
      'org1',
      { [ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS]: 60, [ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS]: 14 },
      'admin1',
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.orgSetting.upsert).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'OrgSetting', actorId: 'admin1' }), tx);
  });

  it('refuses a key it does not know, writing nothing (400)', async () => {
    const { svc, tx } = setup();
    await expect(
      svc.setEditable('org1', { [ORG_SETTING_KEYS.CUSTOMER_MERGE_ENABLED]: true } as never, 'admin1'),
    ).rejects.toThrow(new BadRequestException('Unknown setting key'));
    await expect(svc.setEditable('org1', { 'made.up': 1 } as never, 'admin1')).rejects.toThrow('Unknown setting key');
    expect(tx.orgSetting.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS, 0],
    [ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS, 366],
    [ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS, 10.5],
    [ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS, -1],
    [ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS, '30'],
    [ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD, 0.4],
    [ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD, 1.01],
  ])('refuses %s = %p as out of range (400)', async (key, value) => {
    const { svc, tx } = setup();
    await expect(svc.setEditable('org1', { [key]: value } as never, 'admin1')).rejects.toThrow(
      new BadRequestException('Setting value out of range'),
    );
    expect(tx.orgSetting.upsert).not.toHaveBeenCalled();
  });

  it('accepts the edges: 1 and 365 days, 0.5 and 1 for the threshold', async () => {
    const { svc } = setup();
    await expect(
      svc.setEditable(
        'org1',
        {
          [ORG_SETTING_KEYS.PROPOSAL_VALIDITY_DAYS]: 1,
          [ORG_SETTING_KEYS.PROPOSAL_COST_AGE_WARN_DAYS]: 365,
          [ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD]: 0.5,
        },
        'admin1',
      ),
    ).resolves.toBeUndefined();
    await expect(
      svc.setEditable('org1', { [ORG_SETTING_KEYS.CUSTOMER_SIMILARITY_THRESHOLD]: 1 }, 'admin1'),
    ).resolves.toBeUndefined();
  });

  it('an empty patch writes nothing', async () => {
    const { svc, prisma } = setup();
    await svc.setEditable('org1', {}, 'admin1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
