// vendor_bill flow (T-27): bill_create → manual (the three-way match on NPI's
// screen). NPI's `createBill` creates the bill DRAFT from the goods receipt and
// recomputes the amounts itself; `/bills/{id}/match` is not the copilot's call.
import { billDtoFrom, type VendorBillValues } from '../../extract/schemas/vendor_bill';
import { t } from '../../i18n/ar';
import { pickedId } from '../../intake/resolution';
import type { CreatedEntity } from '../../intake/types';
import { readEntityRef } from '../../npi/responses';
import { labelled, PlanError, type PlannedStep, type PlanInput } from '../plan';
import type { PerformContext } from '../run';

export function planVendorBill(input: PlanInput, labels: string[]): PlannedStep[] {
  const values = input.values as VendorBillValues;
  const resolution = input.resolution;
  const goodsReceiptId = pickedId(resolution?.goodsReceipt, input.choices.goodsReceipt);
  if (goodsReceiptId === null) {
    throw new PlanError(t('exec.error.plan', { reason: t('exec.reason.entity_undecided', { entity: t('exec.kind.goods_receipt') }) }));
  }
  const po = resolution?.purchaseOrder;
  const purchaseOrderId = po?.kind === 'matched' ? po.id : null;
  const dto = billDtoFrom(values, { goodsReceiptId });
  return labelled(labels, [{ kind: 'bill_create', purchaseOrderId, dto }, { kind: 'manual' }]);
}

export async function performVendorBill(step: PlannedStep, ctx: PerformContext): Promise<{ entity: CreatedEntity | null }> {
  switch (step.kind) {
    case 'bill_create': {
      const ref = readEntityRef(await ctx.npi.createBill(step.dto));
      return {
        entity: {
          kind: 'vendor_bill',
          id: ref.id,
          code: ref.code,
          npiPath: step.purchaseOrderId !== null ? `/procurement/${step.purchaseOrderId}` : null,
        },
      };
    }
    default:
      throw new Error(`performVendorBill: unexpected step kind ${step.kind}`);
  }
}
