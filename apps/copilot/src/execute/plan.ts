// The execution plan (T-27, F-11, D-T27-2): the ordered NPI calls an approved
// preview turns into. Pure — no NPI, no database, no model. The plan mirrors
// `previewSteps` one to one (same count, same order, same Arabic label) because
// the card already promised those steps to the user; a mismatch is a bug and
// is refused (`PlanError`) before anything is written.
//
// Each flow's `plan<Flow>` lives in `flows/<flow>.ts` together with its
// `perform<Flow>`; this file holds the shared shapes and the dispatcher.
import type { CreateCustomerDto, CustomerContractValues } from '../extract/schemas/customer_contract';
import type { ReceiveDto } from '../extract/schemas/grn';
import type { CreateVendorDto, PoValues } from '../extract/schemas/po';
import type { CreateRequisitionDto } from '../extract/schemas/pr';
import type { CreateBillDto } from '../extract/schemas/vendor_bill';
import { t } from '../i18n/ar';
import { previewSteps } from '../intake/preview';
import type { FlowResolution, FlowType } from '../intake/types';
import { planCustomerContract } from './flows/customer_contract';
import { planGrn } from './flows/grn';
import { planPo } from './flows/po';
import { planPr } from './flows/pr';
import { planVendorBill } from './flows/vendor_bill';

/** What a step needs from an earlier one: an NPI id already known, or the id
 *  the step with that 1-based number creates. */
export type Ref = { id: string } | { fromStep: number };

/** `PoResolution` without the vendor (the vendor id is a `Ref`: the vendor may
 *  be created by an earlier step of the same plan). */
export interface PoCreateResolution {
  projectId: string | null;
  lines: { itemId: string; wbsElementId: string | null }[];
}

export type PlannedStepBody =
  | { kind: 'manual' }
  | { kind: 'customer_create'; dto: CreateCustomerDto }
  | { kind: 'customer_use'; customerId: string }
  | { kind: 'contract_create'; customer: Ref; values: CustomerContractValues }
  | { kind: 'attach'; entityType: 'contract'; target: Ref }
  | { kind: 'requisition_create'; dto: CreateRequisitionDto }
  | { kind: 'requisition_submit'; requisition: Ref }
  | { kind: 'vendor_create'; dto: CreateVendorDto }
  | { kind: 'vendor_use'; vendorId: string }
  | { kind: 'po_create'; vendor: Ref; values: PoValues; resolved: PoCreateResolution }
  | {
      kind: 'po_convert';
      vendor: Ref;
      requisitionId: string;
      requisitionCode: string;
      lines: { itemId: string; itemName: string; unitPrice: number }[];
      currency: string | null;
    }
  | { kind: 'grn_create'; purchaseOrderId: string; dto: ReceiveDto }
  | { kind: 'bill_create'; purchaseOrderId: string | null; dto: CreateBillDto };

export type PlannedStep = { n: number; labelAr: string } & PlannedStepBody;

export interface ExecutionPlan {
  flow: FlowType;
  steps: PlannedStep[];
}

/** The plan cannot be built from what was approved; nothing was written. */
export class PlanError extends Error {
  constructor(readonly messageAr: string) {
    super('PlanError');
    this.name = 'PlanError';
  }
}

/** A step that cannot be performed for a reason known before the NPI write it
 *  guards (nothing was written by that step). The runner marks the step failed
 *  with `messageAr` and stops — it is not an unexpected error. */
export class StepFailure extends Error {
  constructor(readonly messageAr: string) {
    super('StepFailure');
    this.name = 'StepFailure';
  }
}

export interface PlanInput {
  flow: FlowType;
  values: unknown;
  resolution: FlowResolution | null;
  choices: Record<string, string>;
  hasDocument: boolean;
}

/** A `PlanError` whose reason is the generic «steps drift» sentence. */
export function driftError(): PlanError {
  return new PlanError(t('exec.error.plan', { reason: t('exec.reason.steps_drift') }));
}

/** Numbers `bodies` and gives each the label `previewSteps` promised for its
 *  position; a count mismatch is drift. */
export function labelled(labels: string[], bodies: PlannedStepBody[]): PlannedStep[] {
  if (bodies.length !== labels.length) throw driftError();
  return bodies.map((body, i) => ({ ...body, n: i + 1, labelAr: labels[i] }) as PlannedStep);
}

export function buildPlan(input: PlanInput): ExecutionPlan {
  const { flow } = input;
  if (input.values === null || input.values === undefined) throw driftError();

  const labels = previewSteps(flow, input.values, input.resolution, input.choices, input.hasDocument).map((s) => s.labelAr);

  let steps: PlannedStep[];
  try {
    switch (flow) {
      case 'customer_contract':
        steps = planCustomerContract(input, labels);
        break;
      case 'pr':
        steps = planPr(input, labels);
        break;
      case 'po':
        steps = planPo(input, labels);
        break;
      case 'grn':
        steps = planGrn(input, labels);
        break;
      case 'vendor_bill':
        steps = planVendorBill(input, labels);
        break;
    }
  } catch (err) {
    if (err instanceof PlanError) throw err;
    // A DTO builder's own guard: the preview blockers should have stopped it.
    console.error('[copilot] plan', flow, err instanceof Error ? err.message : err);
    throw driftError();
  }

  if (steps.length !== labels.length || steps.some((s, i) => s.labelAr !== labels[i])) throw driftError();
  return { flow, steps };
}
