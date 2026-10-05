// po flow (T-27): [vendor_use | vendor_create] → po_create | po_convert →
// manual (the approval matrix). NPI creates the order DRAFT with its workflow
// instance (procurement.service.ts `createPo`); NPI's `/approve` is an approval
// the copilot must not call, so «po_matrix» is a manual step.
import { convertToPoDtoFrom, poDtoFrom, vendorDtoFrom, type PoValues } from '../../extract/schemas/po';
import { t } from '../../i18n/ar';
import { pickedId } from '../../intake/resolution';
import type { CreatedEntity } from '../../intake/types';
import { readEntityRef, readRequisitionLines } from '../../npi/responses';
import { driftError, labelled, PlanError, StepFailure, type PlannedStep, type PlannedStepBody, type PlanInput } from '../plan';
import type { PerformContext } from '../run';
import { itemIdOf } from './pr';

export function planPo(input: PlanInput, labels: string[]): PlannedStep[] {
  const values = input.values as PoValues;
  const resolution = input.resolution;
  if (values.vendor === null) {
    throw new PlanError(t('exec.error.plan', { reason: t('exec.reason.entity_undecided', { entity: t('exec.kind.vendor') }) }));
  }

  const vendorId = pickedId(resolution?.vendor, input.choices.vendor);
  const vendor = vendorId !== null ? { id: vendorId } : { fromStep: 1 };
  const bodies: PlannedStepBody[] = [vendorId !== null ? { kind: 'vendor_use', vendorId } : { kind: 'vendor_create', dto: vendorDtoFrom(values.vendor) }];

  const itemIds = values.lines.map((line, i) => itemIdOf(input, i, line.itemName));

  const requisition = resolution?.requisition;
  if (requisition?.kind === 'matched') {
    bodies.push({
      kind: 'po_convert',
      vendor,
      requisitionId: requisition.id,
      requisitionCode: requisition.labelAr,
      lines: values.lines.map((line, i) => {
        if (line.unitPrice === null) throw driftError();
        return { itemId: itemIds[i], itemName: line.itemName, unitPrice: line.unitPrice };
      }),
      currency: values.currency,
    });
  } else {
    const resolved = {
      projectId: pickedId(resolution?.project, input.choices.project),
      lines: values.lines.map((_, i) => ({
        itemId: itemIds[i],
        wbsElementId: pickedId(resolution?.lines[i]?.wbs, input.choices[`lines.${i}.wbs`]),
      })),
    };
    // Dry run: the DTO builder refuses a line without a price; better here than mid-execution.
    poDtoFrom(values, { vendorId: vendorId ?? 'pending', ...resolved });
    bodies.push({ kind: 'po_create', vendor, values, resolved });
  }
  bodies.push({ kind: 'manual' });
  return labelled(labels, bodies);
}

export async function performPo(step: PlannedStep, ctx: PerformContext): Promise<{ entity: CreatedEntity | null }> {
  switch (step.kind) {
    case 'vendor_use':
      return { entity: null };
    case 'vendor_create': {
      const ref = readEntityRef(await ctx.npi.createVendor(step.dto));
      return { entity: { kind: 'vendor', id: ref.id, code: ref.code, npiPath: '/procurement' } };
    }
    case 'po_create': {
      const dto = poDtoFrom(step.values, { vendorId: ctx.resolveRef(step.vendor), ...step.resolved });
      const ref = readEntityRef(await ctx.npi.createPurchaseOrder(dto));
      return { entity: { kind: 'purchase_order', id: ref.id, code: ref.code, npiPath: `/procurement/${ref.id}` } };
    }
    case 'po_convert': {
      // NPI prices a conversion by requisition line id, which only NPI knows:
      // read the requisition's lines now (a read — nothing is written yet) and
      // pair each quoted line with an unused requisition line of the same item.
      const requisitionLines = readRequisitionLines(await ctx.npi.getRequisition(step.requisitionId));
      const used = new Set<string>();
      const prices: { requisitionLineId: string; unitPrice: number }[] = [];
      for (const line of step.lines) {
        const match = requisitionLines.find((l) => l.itemId === line.itemId && !used.has(l.id));
        if (match === undefined) {
          throw new StepFailure(t('exec.reason.requisition_line', { name: line.itemName, code: step.requisitionCode }));
        }
        used.add(match.id);
        prices.push({ requisitionLineId: match.id, unitPrice: line.unitPrice });
      }
      // `convertToPo` returns the PurchaseOrder row (`return po;`, requisitions.service.ts:608).
      const ref = readEntityRef(await ctx.npi.convertRequisition(step.requisitionId, convertToPoDtoFrom(ctx.resolveRef(step.vendor), prices, step.currency)));
      return { entity: { kind: 'purchase_order', id: ref.id, code: ref.code, npiPath: `/procurement/${ref.id}` } };
    }
    default:
      throw new Error(`performPo: unexpected step kind ${step.kind}`);
  }
}
