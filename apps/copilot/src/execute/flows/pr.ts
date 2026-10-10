// pr flow (T-27): requisition_create (DRAFT) → requisition_submit. NPI's SUBMIT
// action moves it to PENDING_APPROVAL (or APPROVED when no rule applies) —
// the approval itself stays on NPI's inbox; the copilot never decides.
import { requisitionDtoFrom, type PrValues } from '../../extract/schemas/pr';
import { t } from '../../i18n/ar';
import { pickedId } from '../../intake/resolution';
import type { CreatedEntity } from '../../intake/types';
import { readEntityRef } from '../../npi/responses';
import { labelled, PlanError, type PlannedStep, type PlanInput } from '../plan';
import type { PerformContext } from '../run';

/** D-T27-5: NPI needs an `itemId` on every line and the copilot cannot create
 *  catalogue items, so a line whose item is not in NPI stops the plan. */
export function itemIdOf(input: PlanInput, index: number, itemName: string): string {
  const itemId = pickedId(input.resolution?.lines[index]?.item, input.choices[`lines.${index}.item`]);
  if (itemId === null) throw new PlanError(t('exec.error.plan', { reason: t('preview.item_required', { name: itemName }) }));
  return itemId;
}

export function planPr(input: PlanInput, labels: string[]): PlannedStep[] {
  const values = input.values as PrValues;
  const resolution = input.resolution;
  const lines = values.lines.map((line, i) => ({
    itemId: itemIdOf(input, i, line.itemName),
    wbsElementId: pickedId(resolution?.lines[i]?.wbs, input.choices[`lines.${i}.wbs`]),
    estimatedUnitPrice: resolution?.lines[i]?.unitCost ?? null,
  }));
  const dto = requisitionDtoFrom(values, {
    projectId: pickedId(resolution?.project, input.choices.project),
    departmentId: pickedId(resolution?.department, input.choices.department),
    lines,
  });
  return labelled(labels, [
    { kind: 'requisition_create', dto },
    { kind: 'requisition_submit', requisition: { fromStep: 1 } },
  ]);
}

export async function performPr(step: PlannedStep, ctx: PerformContext): Promise<{ entity: CreatedEntity | null }> {
  switch (step.kind) {
    case 'requisition_create': {
      const ref = readEntityRef(await ctx.npi.createRequisition(step.dto));
      return { entity: { kind: 'requisition', id: ref.id, code: ref.code, npiPath: `/requisitions/${ref.id}` } };
    }
    case 'requisition_submit':
      // The id is the one the previous step created; no comment is sent.
      await ctx.npi.submitRequisition(ctx.resolveRef(step.requisition));
      return { entity: null };
    default:
      throw new Error(`performPr: unexpected step kind ${step.kind}`);
  }
}
