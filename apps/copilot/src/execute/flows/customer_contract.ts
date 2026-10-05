// customer_contract flow (T-27): [customer_use | customer_create] →
// contract_create → [attach] → manual (activate the contract on NPI's screen).
// NPI creates the contract DRAFT with its milestones inline
// (contracts.service.ts `create`); activation is not the copilot's call.
import { contractDtoFrom, customerDtoFrom, type CustomerContractValues } from '../../extract/schemas/customer_contract';
import type { CreatedEntity } from '../../intake/types';
import { pickedId } from '../../intake/resolution';
import { readEntityRef } from '../../npi/responses';
import { labelled, type PlannedStep, type PlannedStepBody, type PlanInput } from '../plan';
import type { PerformContext } from '../run';

export function planCustomerContract(input: PlanInput, labels: string[]): PlannedStep[] {
  const values = input.values as CustomerContractValues;
  const customerId = pickedId(input.resolution?.customer, input.choices.customer);

  const bodies: PlannedStepBody[] = [
    customerId !== null ? { kind: 'customer_use', customerId } : { kind: 'customer_create', dto: customerDtoFrom(values.customer) },
    { kind: 'contract_create', customer: customerId !== null ? { id: customerId } : { fromStep: 1 }, values },
  ];
  if (input.hasDocument) bodies.push({ kind: 'attach', entityType: 'contract', target: { fromStep: 2 } });
  bodies.push({ kind: 'manual' });
  return labelled(labels, bodies);
}

export async function performCustomerContract(step: PlannedStep, ctx: PerformContext): Promise<{ entity: CreatedEntity | null }> {
  switch (step.kind) {
    case 'customer_use':
      return { entity: null };
    case 'customer_create': {
      const ref = readEntityRef(await ctx.npi.createCustomer(step.dto));
      return { entity: { kind: 'customer', id: ref.id, code: ref.code, npiPath: '/customers' } };
    }
    case 'contract_create': {
      const ref = readEntityRef(await ctx.npi.createContract(contractDtoFrom(step.values, ctx.resolveRef(step.customer))));
      return { entity: { kind: 'contract', id: ref.id, code: ref.code, npiPath: `/contracts/${ref.id}` } };
    }
    default:
      throw new Error(`performCustomerContract: unexpected step kind ${step.kind}`);
  }
}
