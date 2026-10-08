/**
 * CRM Phase 1 · Step 5 (contract §4, §8) — notifying ONE named user.
 *
 * `notify` (unchanged) fans out by permission. A follow-up task is assigned to a
 * person, not a role, so `notifyUser` writes a single row for that person — and
 * writes nothing for a user who is inactive or belongs to another organization.
 */
import { NotificationService } from './notification.service';

const INPUT = {
  organizationId: 'org1',
  userId: 'u2',
  type: 'TASK_ASSIGNED',
  titleAr: 'كُلِّفت بمهمة متابعة',
  titleEn: 'You were assigned a follow-up task',
  bodyAr: 'TSK-00001',
  linkPath: '/tasks?focus=t1',
};

function setup(user: { id: string } | null = { id: 'u2' }) {
  const client = {
    user: { findFirst: jest.fn().mockResolvedValue(user) },
    notification: {
      create: jest.fn().mockResolvedValue({ id: 'n1' }),
      createMany: jest.fn(),
    },
  };
  return { svc: new NotificationService(client as never), client };
}

describe('NotificationService.notifyUser', () => {
  it('writes exactly one row for the user, with the text, link and organization given', async () => {
    const { svc, client } = setup();
    await expect(svc.notifyUser(INPUT)).resolves.toBe(1);
    expect(client.notification.create).toHaveBeenCalledTimes(1);
    expect(client.notification.create.mock.calls[0][0].data).toEqual({
      organizationId: 'org1',
      userId: 'u2',
      type: 'TASK_ASSIGNED',
      titleAr: INPUT.titleAr,
      titleEn: INPUT.titleEn,
      bodyAr: 'TSK-00001',
      bodyEn: null,
      linkPath: '/tasks?focus=t1',
    });
  });

  it('looks the user up inside the organization and only among the active — so a stranger or a leaver gets 0 and no row', async () => {
    const { svc, client } = setup(null);
    await expect(svc.notifyUser(INPUT)).resolves.toBe(0);
    expect(client.user.findFirst.mock.calls[0][0].where).toEqual({ id: 'u2', organizationId: 'org1', isActive: true });
    expect(client.notification.create).not.toHaveBeenCalled();
  });

  it('inside a transaction it writes through the transaction client, not the pool', async () => {
    const { svc, client } = setup();
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'u2' }) },
      notification: { create: jest.fn().mockResolvedValue({ id: 'n9' }) },
    };
    await expect(svc.notifyUser(INPUT, tx as never)).resolves.toBe(1);
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(client.notification.create).not.toHaveBeenCalled();
  });

  it('does not touch the permission fan-out', async () => {
    const { svc, client } = setup();
    await svc.notifyUser(INPUT);
    expect(client.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('NotificationService.notifyUserBestEffort', () => {
  it('returns what notifyUser returns when all is well', async () => {
    const { svc } = setup();
    await expect(svc.notifyUserBestEffort(INPUT)).resolves.toBe(1);
  });

  it('swallows a failure (the business operation already committed) and returns 0', async () => {
    const { svc, client } = setup();
    client.notification.create.mockRejectedValue(new Error('db down'));
    await expect(svc.notifyUserBestEffort(INPUT)).resolves.toBe(0);
  });
});
