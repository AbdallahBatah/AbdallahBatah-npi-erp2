import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@npi/db';
import type { PrismaService } from '../../prisma/prisma.service';

/** Either the pool or a transaction client: the checks below read through whichever the caller holds. */
export type ScopeClient = Prisma.TransactionClient | PrismaService;

/**
 * What a communication-log entry or a follow-up task points at, after every link has
 * been checked: the customer (with the names a notification needs) and the optional
 * opportunity, project and contact.
 */
export interface CustomerScope {
  customerId: string;
  customerCode: string;
  customerNameAr: string;
  customerNameEn: string;
  opportunityId: string | null;
  projectId: string | null;
  contactId: string | null;
}

export interface ScopeInput {
  customerId: string;
  opportunityId?: string | null;
  projectId?: string | null;
  contactId?: string | null;
}

/**
 * CRM Step 5 (contract §1-1): a log entry and a task belong to a customer, and may name an
 * opportunity, a project and a contact — but only ones that are really that customer's, in
 * that organization.
 *
 *  · the customer must exist in the organization (404) and must not have been merged away
 *    (409 — the same words every other document uses);
 *  · an opportunity must be the SAME customer's (400), a project need only exist in the
 *    organization (the screens do not offer projects yet);
 *  · a contact must be one of THIS customer's people (400): a contact id of another
 *    customer — or another tenant — is "not this customer's", nothing more is said.
 *
 * Every lookup carries the organization, so a stranger's id is indistinguishable from a
 * missing one.
 */
export async function resolveScope(
  db: ScopeClient,
  organizationId: string,
  input: ScopeInput,
): Promise<CustomerScope> {
  const customer = await db.customer.findFirst({
    where: { id: input.customerId, organizationId },
    select: { id: true, code: true, nameAr: true, nameEn: true, mergedIntoId: true },
  });
  if (!customer) throw new NotFoundException('Customer not found');
  if (customer.mergedIntoId) throw new ConflictException('Customer already merged');

  if (input.opportunityId) {
    const opportunity = await db.opportunity.findFirst({
      where: { id: input.opportunityId, organizationId },
      select: { id: true, customerId: true },
    });
    if (!opportunity) throw new NotFoundException('Opportunity not found');
    if (opportunity.customerId !== customer.id) {
      throw new BadRequestException('Opportunity does not belong to this customer');
    }
  }

  if (input.projectId) {
    const project = await db.project.findFirst({
      where: { id: input.projectId, organizationId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');
  }

  if (input.contactId) await assertContactOf(db, organizationId, customer.id, input.contactId);

  return {
    customerId: customer.id,
    customerCode: customer.code,
    customerNameAr: customer.nameAr,
    customerNameEn: customer.nameEn,
    opportunityId: input.opportunityId || null,
    projectId: input.projectId || null,
    contactId: input.contactId || null,
  };
}

/** 400 unless `contactId` is a person of `customerId` in the organization. */
export async function assertContactOf(
  db: ScopeClient,
  organizationId: string,
  customerId: string,
  contactId: string,
): Promise<void> {
  const contact = await db.customerContact.findFirst({
    where: { id: contactId, organizationId, customerId },
    select: { id: true },
  });
  if (!contact) throw new BadRequestException('Contact does not belong to this customer');
}
