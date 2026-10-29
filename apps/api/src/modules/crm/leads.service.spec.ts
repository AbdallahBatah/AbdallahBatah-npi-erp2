/**
 * Package 3 · P3-1 (ADR-03 §4-1) — the lead's negotiation outcome.
 * «جارٍ التفاوض ← تم القبول | تم الرفض»: acceptance IS the conversion,
 * rejection needs a reason, a rejected lead can be reopened, acceptance is final.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { LeadsService } from './leads.service';
import type { AuthUser } from '../../common/auth-user';

const PM = {
  userId: 'u1',
  organizationId: 'org1',
  permissions: ['crm.lead.read', 'crm.lead.write', 'crm.opportunity.write'],
} as unknown as AuthUser;
const LEAD_ONLY = { ...PM, permissions: ['crm.lead.read', 'crm.lead.write'] } as unknown as AuthUser;

const LEAD = {
  id: 'l1',
  organizationId: 'org1',
  code: 'LEAD-00001',
  contactName: 'سعد',
  companyName: 'شركة الأمل',
  status: 'NEGOTIATING',
  phone: null,
  email: null,
  estimatedKwp: null,
  customerId: 'c1',
  rejectionReasonId: null,
  rejectionNotes: null,
};

function setup(lead: Record<string, unknown> = LEAD, reason: unknown = { id: 'lr1' }) {
  const leadTable = {
    findFirst: jest.fn().mockResolvedValue(lead),
    update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const flat: Record<string, unknown> = { ...lead, ...data };
      const rr = data.rejectionReason as { connect?: { id: string }; disconnect?: boolean } | undefined;
      if (rr?.connect) flat.rejectionReasonId = rr.connect.id;
      if (rr?.disconnect) flat.rejectionReasonId = null;
      delete flat.rejectionReason;
      return flat;
    }),
  };
  const tx = {
    lead: leadTable,
    customer: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', mergedIntoId: null }) },
    opportunity: { create: jest.fn().mockResolvedValue({ id: 'opp1', code: 'OPP-00001' }) },
  };
  const prisma = {
    ...tx,
    lossReason: { findFirst: jest.fn().mockResolvedValue(reason) },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const numbering = { next: jest.fn().mockResolvedValue('OPP-00001') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const customers = { normalizeKeys: jest.fn(), assertNoDuplicateKeys: jest.fn() };
  const svc = new LeadsService(prisma as never, numbering as never, audit as never, customers as never);
  return { svc, prisma, leadTable, tx, audit };
}

describe('LeadsService.setStatus — acceptance converts', () => {
  it('ACCEPTED creates the opportunity and marks the lead ACCEPTED in one transaction', async () => {
    const { svc, tx, leadTable } = setup();
    const out = (await svc.setStatus(PM, 'l1', { status: 'ACCEPTED' })) as { opportunity: { id: string } };
    expect(out.opportunity.id).toBe('opp1');
    expect(tx.opportunity.create).toHaveBeenCalledTimes(1);
    expect(tx.opportunity.create.mock.calls[0][0].data).toMatchObject({ stage: 'PROSPECTING', customerId: 'c1' });
    expect(leadTable.update.mock.calls[0][0].data).toMatchObject({
      status: 'ACCEPTED',
      convertedOpportunityId: 'opp1',
      rejectionReasonId: null,
    });
  });

  it('refuses acceptance without crm.opportunity.write (403) and writes nothing', async () => {
    const { svc, tx, leadTable } = setup();
    await expect(svc.setStatus(LEAD_ONLY, 'l1', { status: 'ACCEPTED' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.opportunity.create).not.toHaveBeenCalled();
    expect(leadTable.update).not.toHaveBeenCalled();
  });

  it('refuses to accept a rejected lead — it must be reopened first (409)', async () => {
    const { svc, tx } = setup({ ...LEAD, status: 'REJECTED', rejectionReasonId: 'lr1' });
    await expect(svc.setStatus(PM, 'l1', { status: 'ACCEPTED' })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.opportunity.create).not.toHaveBeenCalled();
  });

  it('treats an accepted lead as final: no rejection, no reopening (409)', async () => {
    const { svc, leadTable } = setup({ ...LEAD, status: 'ACCEPTED' });
    await expect(
      svc.setStatus(PM, 'l1', { status: 'REJECTED', rejectionReasonId: 'lr1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.setStatus(PM, 'l1', { status: 'NEGOTIATING' })).rejects.toBeInstanceOf(ConflictException);
    expect(leadTable.update).not.toHaveBeenCalled();
  });
});

describe('LeadsService.setStatus — rejection and reopening', () => {
  it('REJECTED needs a reason (400)', async () => {
    const { svc, leadTable } = setup();
    await expect(svc.setStatus(PM, 'l1', { status: 'REJECTED' })).rejects.toBeInstanceOf(BadRequestException);
    expect(leadTable.update).not.toHaveBeenCalled();
  });

  it('refuses a reason that is not an active one of this organization (400)', async () => {
    const { svc, prisma } = setup(LEAD, null);
    await expect(
      svc.setStatus(PM, 'l1', { status: 'REJECTED', rejectionReasonId: 'other-org' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lossReason.findFirst.mock.calls[0][0].where).toEqual({
      id: 'other-org',
      organizationId: 'org1',
      isActive: true,
    });
  });

  it('records the reason and notes and audits before/after in the same transaction', async () => {
    const { svc, leadTable, audit, tx } = setup();
    const out = await svc.setStatus(PM, 'l1', {
      status: 'REJECTED',
      rejectionReasonId: 'lr1',
      rejectionNotes: '  السعر أعلى من الميزانية  ',
    });
    expect(leadTable.update.mock.calls[0][0].data).toMatchObject({
      status: 'REJECTED',
      rejectionReason: { connect: { id: 'lr1' } },
      rejectionNotes: 'السعر أعلى من الميزانية',
    });
    expect((out as { lead: { status: string } }).lead.status).toBe('REJECTED');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Lead',
        action: 'STATUS_CHANGE',
        before: expect.objectContaining({ status: 'NEGOTIATING' }),
        after: expect.objectContaining({ status: 'REJECTED', rejectionReasonId: 'lr1' }),
      }),
      tx,
    );
  });

  it('reopening a rejected lead clears the reason (the audit row keeps it)', async () => {
    const { svc, leadTable, audit } = setup({ ...LEAD, status: 'REJECTED', rejectionReasonId: 'lr1', rejectionNotes: 'x' });
    await svc.setStatus(PM, 'l1', { status: 'NEGOTIATING' });
    expect(leadTable.update.mock.calls[0][0].data).toMatchObject({
      status: 'NEGOTIATING',
      rejectionReason: { disconnect: true },
      rejectionNotes: null,
    });
    expect(audit.record.mock.calls[0][0].before).toMatchObject({ status: 'REJECTED', rejectionReasonId: 'lr1' });
  });

  it('refuses a move to the status the lead already has (409)', async () => {
    const { svc } = setup();
    await expect(svc.setStatus(PM, 'l1', { status: 'NEGOTIATING' })).rejects.toBeInstanceOf(ConflictException);
  });
});
