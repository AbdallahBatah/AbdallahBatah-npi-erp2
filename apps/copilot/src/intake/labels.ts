// Static knowledge the preview card needs about each flow's fields (T-26,
// D-T26-7): the Arabic label key of a path, its display kind, which paths NPI
// cannot do without, and how the header fields group into sections.
//
// Everything here is keyed by *normalized* paths: the line index is dropped
// («lines.0.qty» → «lines.qty»), so one label serves every row.
import { ar, type ArKey } from '../i18n/ar';
import type { FlowType } from '../agents/router';
import type { PreviewFieldKind } from './types';

/** Same locale pin as `src/i18n/format.ts` (Latin digits, Gregorian), with the
 *  two decimals a money amount is shown with. */
export function formatAmount(n: number): string {
  return n.toLocaleString('ar-SA-u-nu-latn-ca-gregory', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** «lines.0.qty» → «lines.qty», «milestones.2.amount» → «milestones.amount». */
export function normalizePath(path: string): string {
  return path
    .split('.')
    .filter((segment) => !/^\d+$/.test(segment))
    .join('.');
}

/** The `preview.f.*` key of a field. Throws when there is none, so a field
 *  added to a schema without a label fails loudly (in tests, before a user
 *  ever sees a raw key). */
export function fieldLabelKey(path: string): ArKey {
  const key = `preview.f.${normalizePath(path)}`;
  if (!Object.prototype.hasOwnProperty.call(ar, key)) {
    throw new Error(`labels: no Arabic label (${key}) for field path "${path}"`);
  }
  return key as ArKey;
}

export const ENUM_PATHS: ReadonlySet<string> = new Set(['contractType', 'customer.customerType', 'vendor.vendorType', 'milestones.triggerType', 'action']);

export const AMOUNT_PATHS: ReadonlySet<string> = new Set([
  'totalValue',
  'milestones.amount',
  'lines.estimatedUnitPrice',
  'lines.unitPrice',
  'lines.lineTotal',
  'subtotal',
  'vatAmount',
  'total',
]);

export const NUMBER_PATHS: ReadonlySet<string> = new Set(['retentionPct', 'advancePct', 'milestones.percent', 'milestones.sequence', 'lines.qty']);

export const DATE_PATHS: ReadonlySet<string> = new Set([
  'startDate',
  'endDate',
  'milestones.dueDate',
  'neededBy',
  'quoteDate',
  'validUntil',
  'deliveryDate',
  'invoiceDate',
  'dueDate',
]);

export const CODE_PATHS: ReadonlySet<string> = new Set([
  'projectCode',
  'sourceRequisitionCode',
  'purchaseOrderCode',
  'goodsReceiptCode',
  'lines.sku',
  'lines.wbsCode',
]);

export const SERIALS_PATHS: ReadonlySet<string> = new Set(['lines.serials']);

export function fieldKind(_flow: FlowType, path: string): PreviewFieldKind {
  const p = normalizePath(path);
  if (SERIALS_PATHS.has(p)) return 'serials';
  if (ENUM_PATHS.has(p)) return 'enum';
  if (AMOUNT_PATHS.has(p)) return 'amount';
  if (NUMBER_PATHS.has(p)) return 'number';
  if (DATE_PATHS.has(p)) return 'date';
  if (CODE_PATHS.has(p)) return 'code';
  return 'text';
}

/** Paths NPI cannot do without (D-T26-7); `*` stands for a line index. */
export const REQUIRED_PATHS: Record<FlowType, string[]> = {
  customer_contract: ['customer.nameAr', 'contractType'],
  pr: ['justification', 'lines.*.itemName', 'lines.*.qty'],
  po: ['vendor.nameAr', 'lines.*.itemName', 'lines.*.qty', 'lines.*.unitPrice'],
  grn: ['purchaseOrderCode', 'lines.*.itemName', 'lines.*.qty'],
  // The goods receipt is found by the resolution (a hard blocker otherwise).
  vendor_bill: [],
  user_permissions: ['userName', 'action', 'permissions.*.name'],
};

export function isRequired(flow: FlowType, path: string): boolean {
  const generic = path
    .split('.')
    .map((segment) => (/^\d+$/.test(segment) ? '*' : segment))
    .join('.');
  return REQUIRED_PATHS[flow].includes(generic);
}

export interface SectionSpec {
  key: string;
  titleKey: ArKey;
  /** Header paths (no line prefix), in display order. */
  paths: string[];
}

const CUSTOMER_PATHS = ['customer.nameAr', 'customer.nameEn', 'customer.customerType', 'customer.vatNumber', 'customer.crNumber', 'customer.phone', 'customer.email'];
const VENDOR_PATHS = ['vendor.nameAr', 'vendor.nameEn', 'vendor.vendorType', 'vendor.vatNumber', 'vendor.crNumber', 'vendor.phone', 'vendor.email'];

export const SECTIONS: Record<FlowType, SectionSpec[]> = {
  customer_contract: [
    { key: 'customer', titleKey: 'preview.section.customer', paths: CUSTOMER_PATHS },
    {
      key: 'contract',
      titleKey: 'preview.section.contract',
      paths: ['contractType', 'startDate', 'endDate', 'totalValue', 'retentionPct', 'advancePct'],
    },
  ],
  pr: [
    {
      key: 'request',
      titleKey: 'preview.section.request',
      paths: ['justification', 'projectCode', 'projectName', 'departmentName', 'neededBy', 'currency'],
    },
  ],
  po: [
    { key: 'vendor', titleKey: 'preview.section.vendor', paths: VENDOR_PATHS },
    {
      key: 'quote',
      titleKey: 'preview.section.quote',
      paths: ['quoteRef', 'quoteDate', 'validUntil', 'sourceRequisitionCode', 'projectCode', 'projectName', 'currency'],
    },
    { key: 'totals', titleKey: 'preview.section.totals', paths: ['subtotal', 'vatAmount', 'total'] },
  ],
  grn: [
    {
      key: 'delivery',
      titleKey: 'preview.section.delivery',
      paths: ['purchaseOrderCode', 'deliveryNoteRef', 'deliveryDate', 'vendorName', 'projectCode', 'locationName', 'notes'],
    },
  ],
  vendor_bill: [
    { key: 'vendor', titleKey: 'preview.section.vendor', paths: VENDOR_PATHS },
    {
      key: 'invoice',
      titleKey: 'preview.section.invoice',
      paths: ['invoiceNumber', 'invoiceDate', 'dueDate', 'purchaseOrderCode', 'goodsReceiptCode', 'deliveryNoteRef', 'projectCode', 'currency'],
    },
    { key: 'totals', titleKey: 'preview.section.totals', paths: ['subtotal', 'vatAmount', 'total'] },
  ],
  user_permissions: [{ key: 'change', titleKey: 'preview.section.permission_change', paths: ['userName', 'action', 'reason'] }],
};

/** The array of the assessed tree that holds the repeating rows. */
export const LINE_ARRAY: Record<FlowType, 'milestones' | 'lines' | 'permissions'> = {
  customer_contract: 'milestones',
  pr: 'lines',
  po: 'lines',
  grn: 'lines',
  vendor_bill: 'lines',
  user_permissions: 'permissions',
};

/** Heading of the rows group and the title of each row (`{n}` is 1-based). */
export const LINE_GROUP: Record<FlowType, { titleKey: ArKey; rowKey: ArKey }> = {
  customer_contract: { titleKey: 'preview.lines.milestones', rowKey: 'preview.milestone_title' },
  pr: { titleKey: 'preview.lines.items', rowKey: 'preview.line_title' },
  po: { titleKey: 'preview.lines.items', rowKey: 'preview.line_title' },
  grn: { titleKey: 'preview.lines.received', rowKey: 'preview.line_title' },
  vendor_bill: { titleKey: 'preview.lines.items', rowKey: 'preview.line_title' },
  user_permissions: { titleKey: 'preview.lines.permissions', rowKey: 'preview.permission_title' },
};
