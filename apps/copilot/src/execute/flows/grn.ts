// grn flow (T-27): grn_create → manual (quality inspection on NPI's screen).
// NPI's `receive` creates the goods receipt DRAFT (procurement.service.ts).
import { receiveDtoFrom, type GrnValues } from '../../extract/schemas/grn';
import { t } from '../../i18n/ar';
import { pickedId } from '../../intake/resolution';
import type { CreatedEntity } from '../../intake/types';
import { readEntityRef } from '../../npi/responses';
import { labelled, PlanError, type PlannedStep, type PlanInput } from '../plan';
import type { PerformContext } from '../run';

export function planGrn(input: PlanInput, labels: string[]): PlannedStep[] {
  const values = input.values as GrnValues;
  const resolution = input.resolution;
  const po = resolution?.purchaseOrder;
  if (po?.kind !== 'matched') {
    throw new PlanError(t('exec.error.plan', { reason: t('exec.reason.entity_undecided', { entity: t('exec.kind.purchase_order') }) }));
  }

  const lines = values.lines.map((line, i) => {
    const poLineId = pickedId(resolution?.lines[i]?.poLine, input.choices[`lines.${i}.poLine`]);
    if (poLineId === null) throw new PlanError(t('exec.error.plan', { reason: t('preview.po_line_none', { name: line.itemName }) }));
    // D-T27-11: `isSerialised` is false — the preview already blocks a
    // serialised line without one serial per unit (`serials_required`), and NPI
    // validates the serials again, its message reported verbatim. The location
    // is null: NPI defaults to the first warehouse.
    return { poLineId, isSerialised: false };
  });
  const dto = receiveDtoFrom(values, { purchaseOrderId: po.id, locationId: null, lines });
  return labelled(labels, [{ kind: 'grn_create', purchaseOrderId: po.id, dto }, { kind: 'manual' }]);
}

export async function performGrn(step: PlannedStep, ctx: PerformContext): Promise<{ entity: CreatedEntity | null }> {
  switch (step.kind) {
    case 'grn_create': {
      const ref = readEntityRef(await ctx.npi.receiveOnPurchaseOrder(step.purchaseOrderId, step.dto));
      return { entity: { kind: 'goods_receipt', id: ref.id, code: ref.code, npiPath: `/procurement/${step.purchaseOrderId}` } };
    }
    default:
      throw new Error(`performGrn: unexpected step kind ${step.kind}`);
  }
}
