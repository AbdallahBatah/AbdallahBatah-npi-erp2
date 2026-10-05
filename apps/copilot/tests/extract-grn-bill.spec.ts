// T-25: goods receipt from a delivery-note photo (F-08) and vendor bill linked
// to a PO / GRN (F-09) — schemas, assessment, DTO builders, runner (vision and
// sentence), resolution against NPI's purchase-order detail, strings.
import type { LlmContext } from '../src/llm/client';
import type { ConsentedBase64, ModelResponse, RedactedBlock, RedactedRequest } from '../src/llm/provider';
import { Pseudonymizer } from '../src/privacy/pseudonymizer';
import { loadPrompt } from '../src/prompts/load';
import { FLOWS, flattenFields, runExtraction, type ExtractDeps, type ExtractFailure, type ExtractionResult } from '../src/extract/run';
import { serialsField, splitSerials } from '../src/extract/schemas/common';
import { assessPo, assessVendor, type VendorOutput } from '../src/extract/schemas/po';
import {
  assessGrn,
  batchNoField,
  GrnOutputSchema,
  receiveDtoFrom,
  type GrnLineOutput,
  type GrnOutput,
  type GrnResolution,
  type GrnValues,
} from '../src/extract/schemas/grn';
import {
  assessVendorBill,
  billDtoFrom,
  VendorBillOutputSchema,
  type BillLineOutput,
  type VendorBillOutput,
  type VendorBillValues,
} from '../src/extract/schemas/vendor_bill';
import {
  billTotalWarnings,
  expectedBillAmounts,
  goodsReceiptBlockers,
  purchaseOrderDetailFromNpi,
  purchaseOrderReceivable,
  purchaseOrdersFromNpi,
  receiptLineWarnings,
  RECEIVABLE_PO_STATUSES,
  resolveGoodsReceipt,
  resolvePoLine,
  type GoodsReceiptRef,
  type PoLineRef,
  type PurchaseOrderDetail,
} from '../src/extract/resolve';
import { ar } from '../src/i18n/ar';

// ─── helpers ────────────────────────────────────────────────────────────────

const ctx: LlmContext = { npiOrgId: 'org-1', npiUserId: 'user-1' };

/** A wire field as the model returns it: every member present, «» for absent. */
type W = { value: string; confidence: number; evidence: string; page: number };
const f = (value: string | number | null, confidence = 1, evidence: string | null = 'q', page: number | null = 1): W => ({
  value: value === null ? '' : String(value),
  confidence,
  evidence: evidence ?? '',
  page: page ?? 0,
});
const none = (): W => ({ value: '', confidence: 0, evidence: '', page: 0 });

const TODAY = '2026-10-05'; // a Monday
const FLAGS = { ligatureSuspect: false, referenceDate: TODAY };

/** `n` consecutive serials «PREFIX-0001»… starting at `from`. */
const serialList = (prefix: string, from: number, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(from + i).padStart(4, '0')}`);

// ── GRN (F-08) ──

function grnLine(overrides: Partial<GrnLineOutput> = {}): GrnLineOutput {
  return {
    itemName: f('لوح شمسي 550 واط'),
    sku: f('MOD-550'),
    qty: f(8),
    unit: f('قطعة'),
    serials: f(serialList('GS550-2609', 1, 8).join(';')),
    batchNo: none(),
    notes: none(),
    ...overrides,
  };
}

/** Delivery note DN-4471 on PO-00007 as the model reads the photo. */
function grnOutput(overrides: Partial<GrnOutput> = {}): GrnOutput {
  return {
    purchaseOrderCode: f('PO-00007'),
    deliveryNoteRef: f('DN-4471'),
    deliveryDate: f('2026-10-04'),
    vendorName: f('شركة الخليج للألواح الشمسية'),
    projectCode: f('PRJ-00012'),
    locationName: f('مستودع الرياض'),
    notes: none(),
    lines: [
      grnLine(),
      grnLine({ itemName: f('عاكس 50 كيلوواط'), sku: f('INV-50K'), qty: f(1), serials: f('INV50K-26-0117') }),
      grnLine({ itemName: f('قضيب تثبيت'), sku: f('MNT-RAIL'), qty: f(120), unit: f('متر'), serials: none() }),
    ],
    ...overrides,
  };
}

// ── vendor bill (F-09) ──

function vendorOutput(overrides: Partial<VendorOutput> = {}): VendorOutput {
  return {
    nameAr: f('شركة الخليج للألواح الشمسية'),
    nameEn: f('Gulf Solar Panels Co.'),
    vendorType: f('SUPPLIER'),
    vatNumber: f('311111111111113'),
    crNumber: f('1010111222'),
    phone: f('+966501111111'),
    email: f('sales@gulfsolar.sa'),
    ...overrides,
  };
}

function billLine(overrides: Partial<BillLineOutput> = {}): BillLineOutput {
  return {
    itemName: f('لوح شمسي 550 واط'),
    sku: f('MOD-550'),
    qty: f(40),
    unit: f('قطعة'),
    unitPrice: f(320),
    lineTotal: f(12800),
    ...overrides,
  };
}

/** Invoice INV-2026-0912: three lines, 21,460 + 3,219 VAT = 24,679. */
function billOutput(overrides: Partial<VendorBillOutput> = {}, vendor: Partial<VendorOutput> = {}): VendorBillOutput {
  return {
    vendor: vendorOutput(vendor),
    invoiceNumber: f('INV-2026-0912'),
    invoiceDate: f('2026-10-05'),
    dueDate: f('2026-11-04'),
    purchaseOrderCode: f('PO-00007'),
    goodsReceiptCode: f('GRN-00003'),
    deliveryNoteRef: f('DN-4471'),
    projectCode: f('PRJ-00012'),
    currency: none(),
    subtotal: f(21460),
    vatAmount: f(3219),
    total: f(24679),
    lines: [
      billLine(),
      billLine({ itemName: f('عاكس 50 كيلوواط'), sku: f('INV-50K'), qty: f(1), unitPrice: f(6500), lineTotal: f(6500) }),
      billLine({ itemName: f('قضيب تثبيت'), sku: f('MNT-RAIL'), qty: f(120), unit: f('متر'), unitPrice: f(18), lineTotal: f(2160) }),
    ],
    ...overrides,
  };
}

// ── runner plumbing ──

class FakeLlm {
  requests: RedactedRequest[] = [];
  constructor(private impl: (req: RedactedRequest) => ModelResponse | Promise<ModelResponse>) {}
  async complete(req: RedactedRequest, _ctx: LlmContext): Promise<ModelResponse> {
    this.requests.push(req);
    return this.impl(req);
  }
}

function reply(text: string, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return { text, toolCalls: [], stopReason: 'end_turn', tokensIn: 100, tokensOut: 50, modelId: 'claude-sonnet-5', ...overrides };
}

function depsWith(llm: FakeLlm, pseudonymizer = new Pseudonymizer([])): ExtractDeps {
  return { llm, pseudonymizer };
}

function outboundText(req: RedactedRequest): string {
  const content = req.messages[0].content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

async function okRun<K extends 'grn' | 'vendor_bill'>(result: ExtractionResult | ExtractFailure): Promise<ExtractionResult<K>> {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`);
  return result as ExtractionResult<K>;
}

/** One JPEG page as `src/llm/vision.ts` hands it over after a verified consent. */
const photoBlock = (consentEventId = 'consent-1'): RedactedBlock => ({
  type: 'image',
  mediaType: 'image/jpeg',
  data: 'AAAA' as ConsentedBase64,
  consentEventId,
  sizeBytes: 3,
});

const BILL_SENTENCE = 'سجّل فاتورة المورد رقم INV-2026-0912 على أمر الشراء PO-00007 والاستلام GRN-00003 بمبلغ 24,679 شامل الضريبة';

const BILL_TEXT = `فاتورة ضريبية رقم INV-2026-0912 بتاريخ 2026-10-05
من: شركة الخليج للألواح الشمسية، الرقم الضريبي 311111111111113، السجل التجاري 1010111222.
إلى: شركة NPI للطاقة الشمسية.
أمر الشراء: PO-00007، سند الاستلام: GRN-00003، إشعار التسليم: DN-4471
لوح شمسي 550 واط (MOD-550) 40 قطعة × 320 ريال = 12,800 ريال
المجموع قبل الضريبة: 12,800 ريال، ضريبة القيمة المضافة 15%: 1,920 ريال، الإجمالي: 14,720 ريال.`;

const count = (text: string, token: string) => text.split(token).length - 1;

// ─── 1. schemas ─────────────────────────────────────────────────────────────

describe.each([
  ['grn', FLOWS.grn, 'extract/grn.md', 'extract_grn', ['PO-00007']],
  ['vendor_bill', FLOWS.vendor_bill, 'extract/vendor_bill.md', 'extract_vendor_bill', ['PO-00007', 'GRN-00003', 'SUPPLIER | SUBCONTRACTOR | OEM | SERVICE']],
] as const)('%s model-facing schema', (name, spec, promptFile, purpose, mustContain) => {
  const schema = spec.jsonSchema;
  const text = JSON.stringify(schema);

  it('is registered with its prompt file and audit purpose', () => {
    expect(spec.flow).toBe(name);
    expect(spec.promptFile).toBe(promptFile);
    expect(spec.purpose).toBe(purpose);
  });

  it('carries no keyword structured output rejects, no unions, and every object is strict', () => {
    for (const keyword of ['"minimum"', '"maximum"', '"pattern"', '"minLength"', '"maxLength"', '"multipleOf"', '"anyOf"', '"oneOf"', '"null"']) {
      expect(text).not.toContain(keyword);
    }
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object' || node === null) return;
      const obj = node as Record<string, unknown>;
      if (obj.type === 'object') {
        expect(obj.additionalProperties).toBe(false);
        expect(Object.keys(obj.properties as object).sort()).toEqual([...(obj.required as string[])].sort());
      }
      Object.values(obj).forEach(walk);
    };
    walk(schema);
  });

  it('hoists the repeated field shape into $defs', () => {
    const defs = (schema as { $defs?: Record<string, { properties: Record<string, unknown> }> }).$defs;
    expect(defs).toBeDefined();
    const shapes = Object.values(defs!);
    expect(shapes.length).toBeGreaterThanOrEqual(1);
    expect(shapes.some((s) => ['value', 'confidence', 'evidence', 'page'].every((k) => k in s.properties))).toBe(true);
  });

  it('describes the date format and the example codes the model must follow', () => {
    expect(text).toContain('YYYY-MM-DD');
    for (const token of mustContain) expect(text).toContain(token);
  });
});

describe('GrnOutputSchema / VendorBillOutputSchema', () => {
  it('accept a complete output and reject a missing lines array', () => {
    expect(GrnOutputSchema.safeParse(grnOutput()).success).toBe(true);
    const brokenGrn = grnOutput() as unknown as Record<string, unknown>;
    delete brokenGrn.lines;
    expect(GrnOutputSchema.safeParse(brokenGrn).success).toBe(false);

    expect(VendorBillOutputSchema.safeParse(billOutput()).success).toBe(true);
    const brokenBill = billOutput() as unknown as Record<string, unknown>;
    delete brokenBill.lines;
    expect(VendorBillOutputSchema.safeParse(brokenBill).success).toBe(false);
  });

  it('reject a GRN line without serials, a bill line without a unit price, and a bill without a vendor member', () => {
    const noSerials = grnLine() as unknown as Record<string, unknown>;
    delete noSerials.serials;
    expect(GrnOutputSchema.safeParse(grnOutput({ lines: [noSerials as unknown as GrnLineOutput] })).success).toBe(false);

    const noPrice = billLine() as unknown as Record<string, unknown>;
    delete noPrice.unitPrice;
    expect(VendorBillOutputSchema.safeParse(billOutput({ lines: [noPrice as unknown as BillLineOutput] })).success).toBe(false);

    const vendor = vendorOutput() as unknown as Record<string, unknown>;
    delete vendor.vatNumber;
    expect(VendorBillOutputSchema.safeParse({ ...billOutput(), vendor }).success).toBe(false);
  });
});

// ─── 2. prompts ─────────────────────────────────────────────────────────────

describe('prompt templates', () => {
  it.each(['extract/grn.md', 'extract/vendor_bill.md'])('%s carries {{today}} and {{our_party_hint}} exactly once', (file) => {
    const prompt = loadPrompt(file);
    expect(count(prompt, '{{today}}')).toBe(1);
    expect(count(prompt, '{{our_party_hint}}')).toBe(1);
  });
});

// ─── 3. splitSerials / serialsField ─────────────────────────────────────────

describe('splitSerials', () => {
  it('splits on a semicolon', () => {
    expect(splitSerials('GS550-0001;GS550-0002')).toEqual(['GS550-0001', 'GS550-0002']);
  });

  it('splits on the Arabic comma, the Latin comma, a bar and newlines, trimming each part', () => {
    expect(splitSerials('BNINV-4401، BNINV-4402 ،BNINV-4403')).toEqual(['BNINV-4401', 'BNINV-4402', 'BNINV-4403']);
    expect(splitSerials('GS550-0001,GS550-0002|GS550-0003')).toEqual(['GS550-0001', 'GS550-0002', 'GS550-0003']);
    expect(splitSerials('GS550-2609-0001\nGS550-2609-0002\r\nGS550-2609-0003')).toEqual(['GS550-2609-0001', 'GS550-2609-0002', 'GS550-2609-0003']);
  });

  it('drops empty parts', () => {
    expect(splitSerials('GS550-0001;; ;GS550-0002;')).toEqual(['GS550-0001', 'GS550-0002']);
    expect(splitSerials('   ')).toEqual([]);
  });

  it('converts Arabic-Indic and Persian digits and uppercases Latin letters', () => {
    expect(splitSerials('gs550-٢٦١٠-٠١٠١;GS550-۲۶۱۰-۰۱۰۲')).toEqual(['GS550-2610-0101', 'GS550-2610-0102']);
    expect(splitSerials('inv50k-26-0117')).toEqual(['INV50K-26-0117']);
  });

  it('collapses inner whitespace', () => {
    expect(splitSerials('GS550   2610  0101;  INV50K 26')).toEqual(['GS550 2610 0101', 'INV50K 26']);
  });
});

describe('serialsField', () => {
  it('reads a list whose length equals the quantity as confirmed', () => {
    const field = serialsField(f('GS550-0001;GS550-0002'), 2);
    expect(field.value).toEqual(['GS550-0001', 'GS550-0002']);
    expect(field.warnings).toEqual([]);
    expect(field.status).toBe('confirmed');
    expect(field.evidence).toBe('q');
    expect(field.page).toBe(1);
  });

  it('treats an empty value as a valid «no serials» state — confirmed, no warnings', () => {
    const expected = { value: [], confidence: 1, evidence: null, page: null, status: 'confirmed', warnings: [] };
    expect(serialsField(none(), 40)).toEqual(expected);
    expect(serialsField(f('   ', 0.2), null)).toEqual(expected);
  });

  it('flags a count different from the quantity, in either direction, and keeps the list', () => {
    const fewer = serialsField(f(serialList('GS550-2610', 101, 4).join(';')), 5);
    expect(fewer.warnings).toEqual(['extract.warn.serials_count']);
    expect(fewer.status).toBe('unconfirmed');
    expect(fewer.value).toEqual(serialList('GS550-2610', 101, 4));

    expect(serialsField(f('INV50K-26-0117;INV50K-26-0118'), 1).warnings).toEqual(['extract.warn.serials_count']);
  });

  it('does not compare the count when the quantity is unknown', () => {
    const field = serialsField(f('GS550-0001;GS550-0002'), null);
    expect(field.warnings).toEqual([]);
    expect(field.status).toBe('confirmed');
  });

  it('flags a repeated serial', () => {
    const field = serialsField(f('INV50K-26-0131;INV50K-26-0132;INV50K-26-0131'), 3);
    expect(field.warnings).toEqual(['extract.warn.serials_duplicate']);
    expect(field.status).toBe('unconfirmed');
    expect(field.value).toEqual(['INV50K-26-0131', 'INV50K-26-0132', 'INV50K-26-0131']);
  });

  it('treats serials equal after normalization as duplicates', () => {
    expect(serialsField(f('inv50k-26-0131;INV50K-26-٠١٣١'), 2).warnings).toEqual(['extract.warn.serials_duplicate']);
  });

  it('keeps the whole list unconfirmed when the OCR confidence is below 0.8 (AT-05)', () => {
    const field = serialsField(f('GS550-2609-0001;GS550-2609-0002', 0.7), 2);
    expect(field.warnings).toEqual(['extract.warn.low_confidence']);
    expect(field.status).toBe('unconfirmed');
    expect(field.value).toEqual(['GS550-2609-0001', 'GS550-2609-0002']);
    expect(field.confidence).toBe(0.7);
  });

  it('adds the count and low-confidence warnings together, without repeats', () => {
    const field = serialsField(f('GS550-2610-0101;GS550-2610-0102', 0.6), 5);
    expect(field.warnings.sort()).toEqual(['extract.warn.low_confidence', 'extract.warn.serials_count']);
  });
});

// ─── 4. assessGrn ───────────────────────────────────────────────────────────

describe('batchNoField', () => {
  it.each([
    ['دفعة B-2026-09', 'B-2026-09'],
    ['رقم الدفعة: 7781', '7781'],
    ['Lot: LOT-7781', 'LOT-7781'],
    ['Batch No. 12', '12'],
    ['تشغيلة 2026-09', '2026-09'],
    ['B-2026-09', 'B-2026-09'],
  ])('reduces «%s» to the code «%s» (first live eval: the label word was copied)', (written, code) => {
    const field = batchNoField(f(written));
    expect(field.value).toBe(code);
    expect(field.status).toBe('confirmed');
  });

  it('keeps an absent batch number absent', () => {
    expect(batchNoField(none()).value).toBeNull();
  });
});

describe('assessGrn', () => {
  it('confirms every stated field of a clean delivery note and yields plain values', () => {
    const { assessed, values } = assessGrn(grnOutput(), FLAGS);

    // Only what the note did not state is unconfirmed, and only as «missing».
    const leaves = flattenFields(assessed);
    const unconfirmed = Object.entries(leaves).filter(([, l]) => l.status === 'unconfirmed');
    expect(unconfirmed.map(([path]) => path).sort()).toEqual(
      ['notes', 'lines.0.batchNo', 'lines.0.notes', 'lines.1.batchNo', 'lines.1.notes', 'lines.2.batchNo', 'lines.2.notes'].sort(),
    );
    expect(unconfirmed.every(([, l]) => l.warnings.length === 1 && l.warnings[0] === 'extract.warn.missing')).toBe(true);
    expect(assessed.purchaseOrderCode.status).toBe('confirmed');
    expect(assessed.deliveryDate.status).toBe('confirmed');
    expect(assessed.lines[0].serials.status).toBe('confirmed');
    expect(assessed.lines[0].qty.status).toBe('confirmed');
    // A line without serials is a valid state, not «missing».
    expect(assessed.lines[2].serials.status).toBe('confirmed');
    expect(assessed.lines[2].serials.value).toEqual([]);

    expect(values).toEqual({
      purchaseOrderCode: 'PO-00007',
      deliveryNoteRef: 'DN-4471',
      deliveryDate: '2026-10-04',
      vendorName: 'شركة الخليج للألواح الشمسية',
      projectCode: 'PRJ-00012',
      locationName: 'مستودع الرياض',
      notes: null,
      lines: [
        { itemName: 'لوح شمسي 550 واط', sku: 'MOD-550', qty: 8, unit: 'قطعة', serials: serialList('GS550-2609', 1, 8), batchNo: null, notes: null },
        { itemName: 'عاكس 50 كيلوواط', sku: 'INV-50K', qty: 1, unit: 'قطعة', serials: ['INV50K-26-0117'], batchNo: null, notes: null },
        { itemName: 'قضيب تثبيت', sku: 'MNT-RAIL', qty: 120, unit: 'متر', serials: [], batchNo: null, notes: null },
      ],
    });
  });

  it('reads a note written in Arabic-Indic digits with a batch and a shortage remark', () => {
    const { assessed, values } = assessGrn(
      grnOutput({
        purchaseOrderCode: f('PO-٠٠٠٠٨'),
        deliveryNoteRef: f('DN-055'),
        deliveryDate: f('٢٠٢٦-١٠-٠٥'),
        vendorName: f('مؤسسة النور للكابلات'),
        projectCode: none(),
        locationName: none(),
        notes: f('تسليم جزئي'),
        lines: [
          grnLine({ itemName: f('كابل DC 6مم'), sku: f('CAB-DC6'), qty: f('١٩٠'), unit: f('متر'), serials: none(), batchNo: f('B-2026-09'), notes: f('نقص ١٠ متر عن المطلوب ٢٠٠') }),
          grnLine({ itemName: f('طقم مكونات مساعدة'), sku: f('BOS-KIT'), qty: f('٣'), unit: f('طقم'), serials: none() }),
        ],
      }),
      FLAGS,
    );
    expect(assessed.purchaseOrderCode.value).toBe('PO-00008');
    expect(assessed.purchaseOrderCode.status).toBe('confirmed');
    expect(assessed.deliveryDate.value).toBe('2026-10-05');
    expect(assessed.deliveryDate.warnings).toEqual([]);
    expect(assessed.lines[0].qty.value).toBe(190);
    expect(values!.notes).toBe('تسليم جزئي');
    expect(values!.lines[0]).toEqual({
      itemName: 'كابل DC 6مم',
      sku: 'CAB-DC6',
      qty: 190,
      unit: 'متر',
      serials: [],
      batchNo: 'B-2026-09',
      notes: 'نقص ١٠ متر عن المطلوب ٢٠٠',
    });
    expect(values!.lines[1].qty).toBe(3);
  });

  it('flags a delivery date after the reference date and keeps the value; today is fine', () => {
    const future = assessGrn(grnOutput({ deliveryDate: f('2026-10-20') }), FLAGS);
    expect(future.assessed.deliveryDate.warnings).toEqual(['extract.warn.date_future']);
    expect(future.assessed.deliveryDate.status).toBe('unconfirmed');
    expect(future.assessed.deliveryDate.value).toBe('2026-10-20');
    expect(future.values!.deliveryDate).toBe('2026-10-20');

    expect(assessGrn(grnOutput({ deliveryDate: f('2026-10-06') }), FLAGS).assessed.deliveryDate.warnings).toEqual(['extract.warn.date_future']);
    expect(assessGrn(grnOutput({ deliveryDate: f(TODAY) }), FLAGS).assessed.deliveryDate.warnings).toEqual([]);
    expect(assessGrn(grnOutput({ deliveryDate: f('2026-10-04') }), FLAGS).assessed.deliveryDate.status).toBe('confirmed');
    // No reference date, no check.
    expect(assessGrn(grnOutput({ deliveryDate: f('2030-01-01') })).assessed.deliveryDate.warnings).toEqual([]);
  });

  it('flags an unreadable delivery date as date_format, not date_future', () => {
    const { assessed } = assessGrn(grnOutput({ deliveryDate: f('١٤٤٨/٠٤/١٤هـ') }), FLAGS);
    expect(assessed.deliveryDate.warnings).toEqual(['extract.warn.date_format']);
    expect(assessed.deliveryDate.value).toBeNull();
  });

  it.each([['0'], ['-3'], ['abc'], ['1.2345']])('flags quantity «%s» and drops the only line, so values are null', (qty) => {
    const { assessed, values } = assessGrn(grnOutput({ lines: [grnLine({ qty: f(qty), serials: none() })] }), FLAGS);
    expect(assessed.lines).toHaveLength(1);
    expect(assessed.lines[0].qty.warnings).toEqual(['extract.warn.quantity']);
    expect(assessed.lines[0].qty.status).toBe('unconfirmed');
    expect(values).toBeNull();
  });

  it('drops only the unusable lines from the values, keeping the order of the rest and every line in the assessment', () => {
    const { assessed, values } = assessGrn(
      grnOutput({
        lines: [
          grnLine({ itemName: f('عاكس 50 كيلوواط'), sku: f('INV-50K'), qty: f(1), serials: f('INV50K-26-0120') }),
          grnLine({ itemName: f('كابل DC 6مم'), qty: f(0), serials: none() }),
          grnLine({ itemName: none(), qty: f(5), serials: none() }),
          grnLine({ itemName: f('قضيب تثبيت'), sku: f('MNT-RAIL'), qty: f(60), unit: f('متر'), serials: none(), notes: f('تالف 2 متر') }),
        ],
      }),
      FLAGS,
    );
    expect(assessed.lines).toHaveLength(4);
    expect(assessed.lines[2].itemName.warnings).toEqual(['extract.warn.missing']);
    expect(values!.lines.map((l) => l.itemName)).toEqual(['عاكس 50 كيلوواط', 'قضيب تثبيت']);
    expect(values!.lines.map((l) => l.qty)).toEqual([1, 60]);
    expect(values!.lines[1].notes).toBe('تالف 2 متر');
  });

  it('values are null when the note yielded no lines at all', () => {
    expect(assessGrn(grnOutput({ lines: [] }), FLAGS).values).toBeNull();
  });

  it('validates the PO code by shape: «PO-00007» is fine, «أمر 7» is code_format and kept', () => {
    const ok = assessGrn(grnOutput({ purchaseOrderCode: f('po-00007') }), FLAGS);
    expect(ok.assessed.purchaseOrderCode.value).toBe('PO-00007');
    expect(ok.assessed.purchaseOrderCode.warnings).toEqual([]);

    const off = assessGrn(grnOutput({ purchaseOrderCode: f('أمر 7') }), FLAGS);
    expect(off.assessed.purchaseOrderCode.warnings).toEqual(['extract.warn.code_format']);
    expect(off.assessed.purchaseOrderCode.status).toBe('unconfirmed');
    expect(off.values!.purchaseOrderCode).toBe('أمر 7');

    const project = assessGrn(grnOutput({ projectCode: f('محطة الرياض') }), FLAGS);
    expect(project.assessed.projectCode.warnings).toEqual(['extract.warn.code_format']);
  });

  it('uppercases a lowercase SKU', () => {
    const { assessed, values } = assessGrn(grnOutput({ lines: [grnLine({ sku: f('mod-550') })] }), FLAGS);
    expect(assessed.lines[0].sku.value).toBe('MOD-550');
    expect(values!.lines[0].sku).toBe('MOD-550');
  });

  it('keeps a vendor name with a word-internal «ال» unconfirmed only when the page showed the ligature artifact', () => {
    const name = 'شركة الأفق للمقاوالت الكهربائية';
    const suspect = assessGrn(grnOutput({ vendorName: f(name) }), { ...FLAGS, ligatureSuspect: true });
    expect(suspect.assessed.vendorName.status).toBe('unconfirmed');
    expect(suspect.assessed.vendorName.warnings).toEqual(['extract.warn.ligature']);
    expect(suspect.values!.vendorName).toBe(name);
    expect(assessGrn(grnOutput({ vendorName: f(name) }), FLAGS).assessed.vendorName.status).toBe('confirmed');
    // The seed vendor has no word-internal «ال».
    expect(assessGrn(grnOutput(), { ...FLAGS, ligatureSuspect: true }).assessed.vendorName.status).toBe('confirmed');
  });

  it('never stores a vendor-name placeholder the model altered', () => {
    const { assessed } = assessGrn(grnOutput({ vendorName: f('⟦جهة_9⟧ وشركاه') }), FLAGS);
    expect(assessed.vendorName.warnings).toEqual(['extract.warn.placeholder']);
    expect(assessed.vendorName.status).toBe('unconfirmed');
  });

  it('keeps the batch number and the line and delivery notes', () => {
    const { assessed, values } = assessGrn(
      grnOutput({
        notes: f('تسليم جزئي'),
        lines: [grnLine({ itemName: f('كابل DC 6مم'), sku: f('CAB-DC6'), qty: f(1500), unit: f('متر'), serials: none(), batchNo: f('LOT-7781'), notes: f('نقص 10 متر') })],
      }),
      FLAGS,
    );
    expect(assessed.lines[0].batchNo.value).toBe('LOT-7781');
    expect(assessed.lines[0].batchNo.status).toBe('confirmed');
    expect(values!.notes).toBe('تسليم جزئي');
    expect(values!.lines[0]).toMatchObject({ batchNo: 'LOT-7781', notes: 'نقص 10 متر', qty: 1500 });
  });

  it('marks a line with five received and four printed serials unconfirmed on the serials only', () => {
    const { assessed, values } = assessGrn(
      grnOutput({ lines: [grnLine({ qty: f(5), serials: f(serialList('GS550-2610', 101, 4).join(';')) })] }),
      FLAGS,
    );
    expect(assessed.lines[0].serials.warnings).toEqual(['extract.warn.serials_count']);
    expect(assessed.lines[0].serials.status).toBe('unconfirmed');
    expect(assessed.lines[0].qty.status).toBe('confirmed');
    expect(values!.lines[0].serials).toEqual(serialList('GS550-2610', 101, 4));
  });

  it('marks duplicate printed serials unconfirmed', () => {
    const { assessed } = assessGrn(
      grnOutput({ lines: [grnLine({ itemName: f('عاكس 50 كيلوواط'), sku: f('INV-50K'), qty: f(3), serials: f('INV50K-26-0131;INV50K-26-0132;INV50K-26-0131') })] }),
      FLAGS,
    );
    expect(assessed.lines[0].serials.warnings).toEqual(['extract.warn.serials_duplicate']);
    expect(assessed.lines[0].serials.status).toBe('unconfirmed');
  });

  it('keeps a doubtful serial list (confidence 0.7) unconfirmed as a whole', () => {
    const { assessed, values } = assessGrn(grnOutput({ lines: [grnLine({ qty: f(2), serials: f('GS550-2609-0001;GS550-2609-0002', 0.7) })] }), FLAGS);
    expect(assessed.lines[0].serials.warnings).toEqual(['extract.warn.low_confidence']);
    expect(assessed.lines[0].serials.status).toBe('unconfirmed');
    expect(values!.lines[0].serials).toEqual(['GS550-2609-0001', 'GS550-2609-0002']);
  });
});

// ─── 5. receiveDtoFrom ──────────────────────────────────────────────────────

describe('receiveDtoFrom', () => {
  const values = assessGrn(grnOutput(), FLAGS).values as GrnValues;
  const resolved = (overrides: Partial<GrnResolution> = {}): GrnResolution => ({
    purchaseOrderId: 'po-7',
    locationId: 'loc-1',
    lines: [
      { poLineId: 'pl-1', isSerialised: true },
      { poLineId: 'pl-2', isSerialised: true },
      { poLineId: 'pl-3', isSerialised: false },
    ],
    ...overrides,
  });

  it('builds ReceiveDto with the resolved ids, serials as a list, and no undefined members', () => {
    const dto = receiveDtoFrom(values, resolved()) as Record<string, unknown>;
    expect(dto).toEqual({
      lines: [
        { poLineId: 'pl-1', qty: 8, serials: serialList('GS550-2609', 1, 8) },
        { poLineId: 'pl-2', qty: 1, serials: ['INV50K-26-0117'] },
        { poLineId: 'pl-3', qty: 120 },
      ],
      notes: 'إشعار تسليم DN-4471',
      locationId: 'loc-1',
    });
    expect(Object.keys(dto).sort()).toEqual(['lines', 'locationId', 'notes']);
    const lines = dto.lines as Record<string, unknown>[];
    expect(Object.keys(lines[0]).sort()).toEqual(['poLineId', 'qty', 'serials']);
    expect(Object.keys(lines[2]).sort()).toEqual(['poLineId', 'qty']);
  });

  it('omits serials when the list is empty and batchNo when null, sends batchNo when read', () => {
    const withBatch: GrnValues = { ...values, lines: [values.lines[0], values.lines[1], { ...values.lines[2], batchNo: 'LOT-7781' }] };
    const dto = receiveDtoFrom(withBatch, resolved()) as { lines: Record<string, unknown>[] };
    expect('serials' in dto.lines[2]).toBe(false);
    expect(dto.lines[2].batchNo).toBe('LOT-7781');
    expect('batchNo' in dto.lines[0]).toBe(false);
  });

  it('omits locationId when none was resolved', () => {
    const dto = receiveDtoFrom(values, resolved({ locationId: null })) as Record<string, unknown>;
    expect('locationId' in dto).toBe(false);
    expect(Object.keys(dto).sort()).toEqual(['lines', 'notes']);
  });

  it('composes the notes from the delivery-note reference and the delivery notes, and omits them when both are absent', () => {
    const both = receiveDtoFrom({ ...values, notes: 'تسليم جزئي' }, resolved()) as Record<string, unknown>;
    expect(both.notes).toBe('إشعار تسليم DN-4471 — تسليم جزئي');

    const refOnly = receiveDtoFrom(values, resolved()) as Record<string, unknown>;
    expect(refOnly.notes).toBe('إشعار تسليم DN-4471');

    const notesOnly = receiveDtoFrom({ ...values, deliveryNoteRef: null, notes: 'تالف 2 متر من القضبان' }, resolved()) as Record<string, unknown>;
    expect(notesOnly.notes).toBe('تالف 2 متر من القضبان');

    const neither = receiveDtoFrom({ ...values, deliveryNoteRef: null, notes: null }, resolved()) as Record<string, unknown>;
    expect('notes' in neither).toBe(false);
  });

  it('throws when a serialised item has a serial count different from the quantity', () => {
    const short: GrnValues = { ...values, lines: [{ ...values.lines[0], qty: 5, serials: serialList('GS550-2610', 101, 4) }, values.lines[1], values.lines[2]] };
    expect(() => receiveDtoFrom(short, resolved())).toThrow('receiveDtoFrom: serial numbers are required by NPI');

    const none: GrnValues = { ...values, lines: [{ ...values.lines[0], serials: [] }, values.lines[1], values.lines[2]] };
    expect(() => receiveDtoFrom(none, resolved())).toThrow('receiveDtoFrom: serial numbers are required by NPI');
  });

  it('does not require serials for an item NPI does not track by serial', () => {
    const odd: GrnValues = { ...values, lines: [values.lines[0], values.lines[1], { ...values.lines[2], serials: ['X-1', 'X-2', 'X-3'] }] };
    expect(() => receiveDtoFrom(odd, resolved())).not.toThrow();
  });

  it('throws when the resolution is not aligned with the lines', () => {
    expect(() => receiveDtoFrom(values, resolved({ lines: [{ poLineId: 'pl-1', isSerialised: true }] }))).toThrow(
      'receiveDtoFrom: resolution lines do not match the extracted lines',
    );
    expect(() => receiveDtoFrom(values, resolved({ lines: [] }))).toThrow('receiveDtoFrom: resolution lines do not match the extracted lines');
  });
});

// ─── 6. assessVendor / assessVendorBill ─────────────────────────────────────

describe('assessVendor', () => {
  it('returns the vendor assessment assessPo produces, bad VAT number included', () => {
    const vendor = vendorOutput({ vatNumber: f('31123456780003') });
    const fromPo = assessPo(
      {
        vendor,
        quoteRef: none(),
        quoteDate: none(),
        validUntil: none(),
        sourceRequisitionCode: f('PR-00012'),
        projectCode: none(),
        projectName: none(),
        currency: none(),
        subtotal: none(),
        vatAmount: none(),
        total: none(),
        lines: [],
      },
      FLAGS,
    );
    const direct = assessVendor(vendor, FLAGS);
    expect(direct.assessed).toEqual(fromPo.assessed.vendor);
    expect(direct.values).toEqual(fromPo.values!.vendor);
    expect(direct.assessed.vatNumber.warnings).toEqual(['extract.warn.vat_format']);
    expect(direct.values!.vatNumber).toBe('31123456780003');
  });

  it('gives null values without a vendor name', () => {
    const { assessed, values } = assessVendor(vendorOutput({ nameAr: none() }), FLAGS);
    expect(values).toBeNull();
    expect(assessed.nameAr.warnings).toEqual(['extract.warn.missing']);
  });
});

describe('assessVendorBill', () => {
  it('confirms every stated field of a clean bill and yields plain values', () => {
    const { assessed, values } = assessVendorBill(billOutput(), FLAGS);
    const leaves = Object.values(flattenFields(assessed));
    const unconfirmed = leaves.filter((l) => l.status === 'unconfirmed');
    expect(unconfirmed.length).toBeGreaterThan(0);
    expect(unconfirmed.every((l) => l.warnings.length === 1 && l.warnings[0] === 'extract.warn.missing')).toBe(true);
    expect(assessed.vendor.vatNumber.status).toBe('confirmed');
    expect(assessed.invoiceDate.status).toBe('confirmed');
    expect(assessed.dueDate.status).toBe('confirmed');
    expect(assessed.goodsReceiptCode.value).toBe('GRN-00003');
    expect(assessed.goodsReceiptCode.status).toBe('confirmed');
    expect(assessed.purchaseOrderCode.status).toBe('confirmed');
    expect(assessed.subtotal.status).toBe('confirmed');
    expect(assessed.total.status).toBe('confirmed');
    expect(assessed.lines.every((l) => l.unitPrice.status === 'confirmed' && l.lineTotal.status === 'confirmed')).toBe(true);

    expect(values).not.toBeNull();
    expect(values!.vendor).toEqual({
      nameAr: 'شركة الخليج للألواح الشمسية',
      nameEn: 'Gulf Solar Panels Co.',
      vendorType: 'SUPPLIER',
      vatNumber: '311111111111113',
      crNumber: '1010111222',
      phone: '+966501111111',
      email: 'sales@gulfsolar.sa',
    });
    expect(values).toMatchObject({
      invoiceNumber: 'INV-2026-0912',
      invoiceDate: '2026-10-05',
      dueDate: '2026-11-04',
      purchaseOrderCode: 'PO-00007',
      goodsReceiptCode: 'GRN-00003',
      deliveryNoteRef: 'DN-4471',
      projectCode: 'PRJ-00012',
      currency: null,
      subtotal: 21460,
      vatAmount: 3219,
      total: 24679,
    });
    expect(values!.lines.map((l) => [l.itemName, l.sku, l.qty, l.unit, l.unitPrice, l.lineTotal])).toEqual([
      ['لوح شمسي 550 واط', 'MOD-550', 40, 'قطعة', 320, 12800],
      ['عاكس 50 كيلوواط', 'INV-50K', 1, 'قطعة', 6500, 6500],
      ['قضيب تثبيت', 'MNT-RAIL', 120, 'متر', 18, 2160],
    ]);
  });

  it('reads a bill written in Arabic-Indic digits with payment terms instead of a due date', () => {
    const { assessed, values } = assessVendorBill(
      billOutput(
        {
          invoiceNumber: f('NR-1182'),
          invoiceDate: f('٢٠٢٦-١٠-٠٥'),
          dueDate: none(),
          purchaseOrderCode: f('PO-٠٠٠٠٨'),
          goodsReceiptCode: none(),
          deliveryNoteRef: f('DN-055'),
          projectCode: none(),
          subtotal: f('٣٬٤٠٠'),
          vatAmount: f('٥١٠'),
          total: f('٣٬٩١٠'),
          lines: [
            billLine({ itemName: f('كابل DC 6مم'), sku: f('CAB-DC6'), qty: f('١٩٠'), unit: f('متر'), unitPrice: f('٤'), lineTotal: f('٧٦٠') }),
            billLine({ itemName: f('طقم مكونات مساعدة'), sku: f('BOS-KIT'), qty: f('٣'), unit: f('طقم'), unitPrice: f('٨٨٠'), lineTotal: f('٢٬٦٤٠') }),
          ],
        },
        { nameAr: f('مؤسسة النور للكابلات'), nameEn: none(), vatNumber: f('٣٠٠٩٨٧٦٥٤٣٠٠٠٠٣'), crNumber: f('٤٠٣٠١٢٣٤٥٦') },
      ),
      FLAGS,
    );
    expect(assessed.vendor.vatNumber.value).toBe('300987654300003');
    expect(assessed.vendor.vatNumber.status).toBe('confirmed');
    expect(assessed.vendor.crNumber.value).toBe('4030123456');
    expect(assessed.purchaseOrderCode.value).toBe('PO-00008');
    expect(assessed.goodsReceiptCode.value).toBeNull();
    expect(values!.invoiceDate).toBe('2026-10-05');
    expect(values!.dueDate).toBeNull();
    expect(values!.subtotal).toBe(3400);
    expect(values!.vatAmount).toBe(510);
    expect(values!.total).toBe(3910);
    expect(values!.lines.map((l) => [l.qty, l.unitPrice, l.lineTotal])).toEqual([
      [190, 4, 760],
      [3, 880, 2640],
    ]);
    expect(assessed.subtotal.warnings).toEqual([]);
    expect(assessed.total.warnings).toEqual([]);
  });

  it('flags an invoice date after the reference date, not today', () => {
    const future = assessVendorBill(billOutput({ invoiceDate: f('2026-10-06') }), FLAGS);
    expect(future.assessed.invoiceDate.warnings).toEqual(['extract.warn.date_future']);
    expect(future.assessed.invoiceDate.status).toBe('unconfirmed');
    expect(future.values!.invoiceDate).toBe('2026-10-06');
    expect(assessVendorBill(billOutput({ invoiceDate: f(TODAY) }), FLAGS).assessed.invoiceDate.warnings).toEqual([]);
    expect(assessVendorBill(billOutput({ invoiceDate: f('2030-01-01') })).assessed.invoiceDate.warnings).toEqual([]);
  });

  it('flags payment terms written in a due-date field as date_format and stores no date', () => {
    const { assessed, values } = assessVendorBill(billOutput({ dueDate: f('30 يوماً') }), FLAGS);
    expect(assessed.dueDate.warnings).toEqual(['extract.warn.date_format']);
    expect(assessed.dueDate.status).toBe('unconfirmed');
    expect(assessed.dueDate.value).toBeNull();
    expect(values!.dueDate).toBeNull();
  });

  it('derives a missing unit price from the line total and leaves it unconfirmed', () => {
    const out = billOutput();
    out.lines[0] = billLine({ qty: f(40, 0.95), unitPrice: none(), lineTotal: f(12800, 0.9) });
    const { assessed, values } = assessVendorBill(out, FLAGS);
    const price = assessed.lines[0].unitPrice;
    expect(price.value).toBe(320);
    expect(price.warnings).toEqual(['extract.warn.derived']);
    expect(price.status).toBe('unconfirmed');
    expect(price.confidence).toBe(0.9);
    expect(values!.lines[0].unitPrice).toBe(320);
    expect(assessed.subtotal.status).toBe('confirmed');
  });

  it('flags qty × price ≠ line total on both fields, and only on that line (bill-03: 40 × 320 printed 12,000)', () => {
    const out = billOutput();
    out.lines[0].lineTotal = f(12000);
    const { assessed } = assessVendorBill(out, FLAGS);
    expect(assessed.lines[0].lineTotal.warnings).toContain('extract.warn.line_total');
    expect(assessed.lines[0].unitPrice.warnings).toContain('extract.warn.line_total');
    expect(assessed.lines[0].lineTotal.status).toBe('unconfirmed');
    expect(assessed.lines[0].unitPrice.status).toBe('unconfirmed');
    expect(assessed.lines[1].unitPrice.warnings).toEqual([]);
    expect(assessed.lines[1].lineTotal.warnings).toEqual([]);
    expect(assessed.subtotal.warnings).toEqual([]);
  });

  it('flags a subtotal the lines do not add up to, on the subtotal and every unit price', () => {
    const { assessed } = assessVendorBill(billOutput({ subtotal: f(25000), vatAmount: f(3750), total: f(28750) }), FLAGS);
    expect(assessed.subtotal.warnings).toContain('extract.warn.lines_sum');
    expect(assessed.subtotal.status).toBe('unconfirmed');
    expect(assessed.lines.every((l) => l.unitPrice.warnings.includes('extract.warn.lines_sum'))).toBe(true);
    expect(assessed.total.warnings).toEqual([]);
    expect(assessed.vatAmount.warnings).toEqual([]);
  });

  it('flags a total that is not subtotal + VAT, on the total and the stated VAT', () => {
    const { assessed } = assessVendorBill(billOutput({ total: f(26000) }), FLAGS);
    expect(assessed.total.warnings).toContain('extract.warn.vat_total');
    expect(assessed.total.status).toBe('unconfirmed');
    expect(assessed.vatAmount.warnings).toContain('extract.warn.vat_total');
    expect(assessed.subtotal.warnings).toEqual([]);
  });

  it('computes the expected VAT at 15 % when the bill states none, and does not check an inclusive-only total', () => {
    const ok = assessVendorBill(billOutput({ vatAmount: none() }), FLAGS);
    expect(ok.assessed.total.warnings).toEqual([]);
    const bad = assessVendorBill(billOutput({ vatAmount: none(), total: f(26000) }), FLAGS);
    expect(bad.assessed.total.warnings).toContain('extract.warn.vat_total');
    expect(bad.assessed.vatAmount.warnings).toEqual(['extract.warn.missing']);

    const inclusive = assessVendorBill(billOutput({ subtotal: none(), vatAmount: none(), total: f(24679) }), FLAGS);
    expect(inclusive.assessed.total.warnings).toEqual([]);
    expect(inclusive.assessed.subtotal.warnings).toEqual(['extract.warn.missing']);
  });

  it('flags a 14-digit VAT number but still carries it into the values', () => {
    const { assessed, values } = assessVendorBill(billOutput({}, { vatNumber: f('31123456780003') }), FLAGS);
    expect(assessed.vendor.vatNumber.warnings).toEqual(['extract.warn.vat_format']);
    expect(assessed.vendor.vatNumber.status).toBe('unconfirmed');
    expect(values!.vendor!.vatNumber).toBe('31123456780003');
  });

  it('reads the currency in any case and refuses a word', () => {
    expect(assessVendorBill(billOutput({ currency: f('usd') }), FLAGS).values!.currency).toBe('USD');
    const word = assessVendorBill(billOutput({ currency: f('دولار أمريكي') }), FLAGS);
    expect(word.assessed.currency.warnings).toEqual(['extract.warn.currency']);
    expect(word.values!.currency).toBeNull();
  });

  it('flags code-shaped fields that are not codes and keeps what was read', () => {
    const { assessed, values } = assessVendorBill(billOutput({ purchaseOrderCode: f('الأمر الأخير'), goodsReceiptCode: f('سند استلام') }), FLAGS);
    expect(assessed.purchaseOrderCode.warnings).toEqual(['extract.warn.code_format']);
    expect(assessed.goodsReceiptCode.warnings).toEqual(['extract.warn.code_format']);
    expect(values!.purchaseOrderCode).toBe('الأمر الأخير');
  });

  it('values are null when there is neither a usable line nor a total (an unreadable photo)', () => {
    const empty = billOutput({ lines: [], subtotal: none(), vatAmount: none(), total: none() });
    expect(assessVendorBill(empty, FLAGS).values).toBeNull();
    const zero = assessVendorBill(billOutput({ lines: [billLine({ qty: f(0) })], subtotal: none(), vatAmount: none(), total: none() }), FLAGS);
    expect(zero.assessed.lines[0].qty.warnings).toEqual(['extract.warn.quantity']);
    expect(zero.values).toBeNull();
  });

  it('keeps values for a total alone — «سجّل فاتورة … بمبلغ 24,679 شامل الضريبة»', () => {
    const sentence = billOutput(
      { lines: [], dueDate: none(), deliveryNoteRef: none(), projectCode: none(), invoiceDate: none(), subtotal: none(), vatAmount: none(), total: f(24679) },
      { nameAr: none(), nameEn: none(), vendorType: none(), vatNumber: none(), crNumber: none(), phone: none(), email: none() },
    );
    const { assessed, values } = assessVendorBill(sentence, FLAGS);
    expect(values).not.toBeNull();
    expect(values!.vendor).toBeNull();
    expect(values!.total).toBe(24679);
    expect(values!.subtotal).toBeNull();
    expect(values!.lines).toEqual([]);
    expect(values!.invoiceNumber).toBe('INV-2026-0912');
    expect(values!.goodsReceiptCode).toBe('GRN-00003');
    expect(assessed.vendor.nameAr.warnings).toEqual(['extract.warn.missing']);
  });

  it('gives null vendor values without a vendor name even when the lines are usable', () => {
    const { values } = assessVendorBill(billOutput({}, { nameAr: none() }), FLAGS);
    expect(values).not.toBeNull();
    expect(values!.vendor).toBeNull();
  });
});

// ─── 7. billDtoFrom ─────────────────────────────────────────────────────────

describe('billDtoFrom', () => {
  const values = assessVendorBill(billOutput(), FLAGS).values as VendorBillValues;

  it('builds CreateBillDto with the goods receipt id and the invoice number as vendorRef', () => {
    const dto = billDtoFrom(values, { goodsReceiptId: 'grn-3' }) as Record<string, unknown>;
    expect(dto).toEqual({ goodsReceiptId: 'grn-3', vendorRef: 'INV-2026-0912' });
  });

  it('omits vendorRef when the bill has no number, and sends no printed amounts', () => {
    const dto = billDtoFrom({ ...values, invoiceNumber: null }, { goodsReceiptId: 'grn-3' }) as Record<string, unknown>;
    expect(Object.keys(dto)).toEqual(['goodsReceiptId']);
    expect(Object.keys(billDtoFrom(values, { goodsReceiptId: 'grn-3' })).sort()).toEqual(['goodsReceiptId', 'vendorRef']);
  });
});

// ─── 8. runner ──────────────────────────────────────────────────────────────

describe('runExtraction (grn, vision)', () => {
  it('labels the photo, passes the block through untouched, and parses the serials as an array', async () => {
    const llm = new FakeLlm(() => reply(JSON.stringify(grnOutput())));
    const block = photoBlock();
    const result = await okRun<'grn'>(
      await runExtraction(depsWith(llm), { flow: 'grn', source: { kind: 'vision', blocks: [block] }, referenceDate: TODAY, ourPartyNameAr: 'شركة NPI للطاقة الشمسية' }, ctx),
    );

    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0];
    expect(req.tier).toBe('advanced');
    expect(req.purpose).toBe('extract_grn');
    expect(req.jsonSchema).toBe(FLOWS.grn.jsonSchema);
    expect(req.system).toContain(TODAY);
    expect(req.system).not.toContain('{{today}}');
    expect(req.system).toContain('شركة NPI للطاقة الشمسية');
    expect(req.system).not.toContain('{{our_party_hint}}');

    const content = req.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as RedactedBlock[];
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('text');
    expect((blocks[0] as { text: string }).text).toContain('المستند مرفق صوراً');
    expect((blocks[0] as { text: string }).text).not.toContain('تلميح المستخدم:');
    expect(blocks[1].type).toBe('text');
    expect((blocks[1] as { text: string }).text).toContain('=== صفحة 1 ===');
    // The label comes before the image, and the image is the very block that was given.
    expect(blocks[2]).toBe(block);
    expect((blocks[2] as { consentEventId: string }).consentEventId).toBe('consent-1');

    expect(Array.isArray(result.fields['lines.0.serials'].value)).toBe(true);
    expect(result.fields['lines.0.serials'].value).toEqual(serialList('GS550-2609', 1, 8));
    expect(result.fields['lines.0.serials'].status).toBe('confirmed');
    expect(result.fields['lines.2.serials'].value).toEqual([]);
    expect(result.values!.purchaseOrderCode).toBe('PO-00007');
    expect(result.values!.vendorName).toBe('شركة الخليج للألواح الشمسية');
    expect(result.values!.lines).toHaveLength(3);
    expect(result.summary.total).toBe(Object.keys(result.fields).length);
    expect(result.summary.confirmed + result.summary.unconfirmed).toBe(result.summary.total);
    expect(result.summary.unconfirmed).toBeGreaterThan(0);
  });

  it('labels every image of a multi-page note in order and keeps the user hint in the first text block', async () => {
    const llm = new FakeLlm(() => reply(JSON.stringify(grnOutput())));
    const first = photoBlock('consent-1');
    const second = photoBlock('consent-1');
    await okRun<'grn'>(
      await runExtraction(depsWith(llm), { flow: 'grn', source: { kind: 'vision', blocks: [first, second] }, userHint: 'استلام من أمر الشراء PO-00007', referenceDate: TODAY }, ctx),
    );
    const blocks = llm.requests[0].messages[0].content as RedactedBlock[];
    expect(blocks).toHaveLength(5);
    expect((blocks[0] as { text: string }).text).toContain('تلميح المستخدم: استلام من أمر الشراء PO-00007');
    expect((blocks[0] as { text: string }).text).toContain('المستند مرفق صوراً');
    expect((blocks[1] as { text: string }).text).toContain('=== صفحة 1 ===');
    expect(blocks[2]).toBe(first);
    expect((blocks[3] as { text: string }).text).toContain('=== صفحة 2 ===');
    expect(blocks[4]).toBe(second);
  });

  it('assesses against the pinned reference date end to end: a future delivery date and a short serial list', async () => {
    const llm = new FakeLlm(() =>
      reply(JSON.stringify(grnOutput({ deliveryDate: f('2026-10-20'), lines: [grnLine({ qty: f(5), serials: f(serialList('GS550-2610', 101, 4).join(';')) })] }))),
    );
    const result = await okRun<'grn'>(await runExtraction(depsWith(llm), { flow: 'grn', source: { kind: 'vision', blocks: [photoBlock()] }, referenceDate: TODAY }, ctx));
    expect(result.fields['deliveryDate'].warnings).toEqual(['extract.warn.date_future']);
    expect(result.fields['deliveryDate'].status).toBe('unconfirmed');
    expect(result.fields['lines.0.serials'].warnings).toEqual(['extract.warn.serials_count']);
    expect(result.fields['lines.0.serials'].status).toBe('unconfirmed');
    expect(result.fields['lines.0.qty'].status).toBe('confirmed');
  });

  it('fails with schema_mismatch when a line lacks the serials member', async () => {
    const broken = grnOutput() as unknown as { lines: Record<string, unknown>[] };
    delete broken.lines[0].serials;
    const llm = new FakeLlm(() => reply(JSON.stringify(broken)));
    const result = await runExtraction(depsWith(llm), { flow: 'grn', source: { kind: 'vision', blocks: [photoBlock()] }, referenceDate: TODAY }, ctx);
    expect(result.ok).toBe(false);
    expect((result as ExtractFailure).reason).toBe('schema_mismatch');
    expect((result as ExtractFailure).messageKey).toBe('extract.failed.invalid_json');
  });

  it('does not call the model for an empty text input', async () => {
    const llm = new FakeLlm(() => reply(JSON.stringify(grnOutput())));
    const empty = await runExtraction(depsWith(llm), { flow: 'grn', source: { kind: 'text', pages: [] } }, ctx);
    expect(empty.ok).toBe(false);
    expect((empty as ExtractFailure).reason).toBe('empty_input');
    expect(llm.requests).toHaveLength(0);
  });
});

describe('runExtraction (vendor_bill)', () => {
  it('reads a sentence on the advanced tier: hint line, no page header, values from the stated total', async () => {
    const llm = new FakeLlm((req) => {
      expect(outboundText(req)).toContain('INV-2026-0912');
      return reply(
        JSON.stringify(
          billOutput(
            { lines: [], dueDate: none(), deliveryNoteRef: none(), projectCode: none(), invoiceDate: none(), subtotal: none(), vatAmount: none(), total: f(24679, 0.95) },
            { nameAr: none(), nameEn: none(), vendorType: none(), vatNumber: none(), crNumber: none(), phone: none(), email: none() },
          ),
        ),
      );
    });
    const result = await okRun<'vendor_bill'>(
      await runExtraction(depsWith(llm), { flow: 'vendor_bill', source: { kind: 'text', pages: [] }, userHint: BILL_SENTENCE, referenceDate: TODAY, ourPartyNameAr: 'شركة NPI للطاقة الشمسية' }, ctx),
    );

    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0];
    expect(req.tier).toBe('advanced');
    expect(req.purpose).toBe('extract_vendor_bill');
    expect(req.jsonSchema).toBe(FLOWS.vendor_bill.jsonSchema);
    expect(req.system).toContain(TODAY);
    expect(req.system).not.toContain('{{today}}');
    expect(req.system).toContain('شركة NPI للطاقة الشمسية');
    expect(outboundText(req)).toContain('تلميح المستخدم:');
    expect(outboundText(req)).toContain('PO-00007');
    expect(outboundText(req)).toContain('GRN-00003');
    expect(outboundText(req)).not.toContain('=== صفحة');

    expect(result.values).not.toBeNull();
    expect(result.values!.total).toBe(24679);
    expect(result.values!.subtotal).toBeNull();
    expect(result.values!.invoiceNumber).toBe('INV-2026-0912');
    expect(result.values!.purchaseOrderCode).toBe('PO-00007');
    expect(result.values!.goodsReceiptCode).toBe('GRN-00003');
    expect(result.values!.lines).toEqual([]);
    expect(result.fields['total'].status).toBe('confirmed');
    expect(result.fields['goodsReceiptCode'].status).toBe('confirmed');
    expect(Object.keys(result.fields).some((k) => k.startsWith('lines.'))).toBe(false);
    expect(result.summary.total).toBe(Object.keys(result.fields).length);
  });

  it('shows the model placeholders for the vendor and its VAT number, and rehydrates the answer', async () => {
    const llm = new FakeLlm((req) => {
      const sent = outboundText(req);
      expect(sent).not.toContain('الخليج للألواح');
      expect(sent).not.toContain('311111111111113');
      const org = /⟦جهة_\d+⟧/.exec(sent)![0];
      const vat = /⟦رقم_ضريبي_\d+⟧/.exec(sent)![0];
      return reply(
        JSON.stringify(
          billOutput(
            { subtotal: f(12800), vatAmount: f(1920), total: f(14720), lines: [billLine()] },
            { nameAr: f(org), vatNumber: f(vat), nameEn: none(), crNumber: f('1010111222'), phone: none(), email: none() },
          ),
        ),
      );
    });
    const result = await okRun<'vendor_bill'>(
      await runExtraction(
        depsWith(llm),
        { flow: 'vendor_bill', source: { kind: 'text', pages: [{ num: 1, text: BILL_TEXT }] }, userHint: 'فاتورة جديدة', referenceDate: TODAY, ourPartyNameAr: 'شركة NPI للطاقة الشمسية' },
        ctx,
      ),
    );

    const req = llm.requests[0];
    expect(req.purpose).toBe('extract_vendor_bill');
    expect(outboundText(req)).toContain('=== صفحة 1 ===');
    expect(outboundText(req)).toContain('تلميح المستخدم: فاتورة جديدة');
    // Document codes and numbers are not pseudonymized.
    expect(outboundText(req)).toContain('INV-2026-0912');
    expect(outboundText(req)).toContain('GRN-00003');

    expect(result.values!.vendor!.nameAr).toBe('شركة الخليج للألواح الشمسية');
    expect(result.values!.vendor!.vatNumber).toBe('311111111111113');
    expect(result.fields['vendor.nameAr'].status).toBe('confirmed');
    expect(result.fields['vendor.vatNumber'].status).toBe('confirmed');
    expect(result.fields['lines.0.unitPrice'].value).toBe(320);
    expect(result.fields['subtotal'].value).toBe(12800);
    expect(result.fields['total'].status).toBe('confirmed');
  });

  it('reads a bill photo (vision) with the same schema and marks a wrong line total unconfirmed end to end', async () => {
    const wrong = billOutput();
    wrong.lines[0].lineTotal = f(12000);
    const llm = new FakeLlm(() => reply(JSON.stringify(wrong)));
    const block = photoBlock();
    const result = await okRun<'vendor_bill'>(await runExtraction(depsWith(llm), { flow: 'vendor_bill', source: { kind: 'vision', blocks: [block] }, referenceDate: TODAY }, ctx));
    const content = llm.requests[0].messages[0].content as RedactedBlock[];
    expect(content[content.length - 1]).toBe(block);
    expect(result.fields['lines.0.lineTotal'].warnings).toContain('extract.warn.line_total');
    expect(result.fields['lines.0.lineTotal'].status).toBe('unconfirmed');
    expect(result.values).not.toBeNull();
  });
});

// ─── 9. resolution ──────────────────────────────────────────────────────────

describe('purchaseOrdersFromNpi (status, vendor, project)', () => {
  const pos = purchaseOrdersFromNpi([
    {
      id: 'po-7',
      code: 'PO-00007',
      vendorId: 'ven-1',
      projectId: 'prj-12',
      status: 'SENT',
      currency: 'SAR',
      vendor: { code: 'VEN-00001', nameAr: 'شركة الخليج للألواح الشمسية', nameEn: 'Gulf Solar Panels Co.' },
      project: { id: 'prj-12', code: 'PRJ-00012' },
      _count: { goodsReceipts: 1 },
    },
    { id: 'po-8', code: 'PO-00008', vendorId: 'ven-2', status: 'DRAFT', vendor: null, project: null },
    { id: 'bad' }, // dropped: no code
  ]);

  it('reads the status, the vendor name and the project code', () => {
    expect(pos).toHaveLength(2);
    expect(pos[0]).toEqual({ id: 'po-7', code: 'PO-00007', vendorId: 'ven-1', status: 'SENT', vendorNameAr: 'شركة الخليج للألواح الشمسية', projectCode: 'PRJ-00012' });
  });

  it('gives null for what the row does not carry', () => {
    expect(pos[1]).toEqual({ id: 'po-8', code: 'PO-00008', vendorId: 'ven-2', status: 'DRAFT', vendorNameAr: null, projectCode: null });
  });
});

describe('purchaseOrderDetailFromNpi', () => {
  const body = {
    id: 'po-7',
    code: 'PO-00007',
    status: 'PARTIALLY_RECEIVED',
    vendorId: 'ven-1',
    currency: 'SAR',
    vendor: { code: 'VEN-00001', nameAr: 'شركة الخليج للألواح الشمسية', nameEn: null },
    project: { id: 'prj-12', code: 'PRJ-00012' },
    lines: [
      {
        id: 'pl-1',
        itemId: 'item-1',
        qty: '40.000',
        unitPrice: '320.00',
        lineTotal: '12800.00',
        receivedQty: '0.000',
        item: { sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', nameEn: 'Solar module 550 W', isSerialised: true, uom: 'unit' },
        wbsElement: null,
      },
      {
        id: 'pl-3',
        itemId: 'item-3',
        qty: '120.000',
        unitPrice: '18.00',
        lineTotal: '2160.00',
        receivedQty: '60.500',
        item: { sku: 'MNT-RAIL', nameAr: 'قضيب تثبيت', nameEn: null, isSerialised: false, uom: 'm' },
      },
      { id: 'pl-9', itemId: 'item-9', qty: 2, unitPrice: 10, receivedQty: 0 }, // no item: sku/names null, not serialised
    ],
    goodsReceipts: [
      {
        id: 'grn-3',
        code: 'GRN-00003',
        status: 'ACCEPTED',
        receivedAt: '2026-10-04T08:00:00.000Z',
        lines: [{ purchaseOrderLineId: 'pl-1', qty: '8.000', serials: ['GS550-2609-0001'], batchNo: null }],
        serialUnits: [{ id: 'su-1' }],
        vendorBills: [],
      },
      {
        id: 'grn-2',
        code: 'GRN-00002',
        status: 'ACCEPTED',
        receivedAt: '2026-10-01T08:00:00.000Z',
        lines: [{ purchaseOrderLineId: 'pl-3', qty: '60.500', serials: [], batchNo: 'LOT-7781' }],
        serialUnits: [],
        vendorBills: [{ id: 'bill-1', code: 'BILL-00001', status: 'DRAFT' }],
      },
    ],
    vendorBills: [{ id: 'bill-1', code: 'BILL-00001', status: 'DRAFT' }],
  };

  it('reads the lines with string decimals as numbers, the item facts and the serialised flag', () => {
    const detail = purchaseOrderDetailFromNpi(body) as PurchaseOrderDetail;
    expect(detail).toMatchObject({ id: 'po-7', code: 'PO-00007', status: 'PARTIALLY_RECEIVED', vendorId: 'ven-1', currency: 'SAR' });
    expect(detail.lines).toEqual([
      { id: 'pl-1', itemId: 'item-1', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', nameEn: 'Solar module 550 W', isSerialised: true, qty: 40, unitPrice: 320, receivedQty: 0 },
      { id: 'pl-3', itemId: 'item-3', sku: 'MNT-RAIL', nameAr: 'قضيب تثبيت', nameEn: null, isSerialised: false, qty: 120, unitPrice: 18, receivedQty: 60.5 },
      { id: 'pl-9', itemId: 'item-9', sku: null, nameAr: null, nameEn: null, isSerialised: false, qty: 2, unitPrice: 10, receivedQty: 0 },
    ]);
    expect(typeof detail.lines[0].qty).toBe('number');
    expect(typeof detail.lines[0].unitPrice).toBe('number');
  });

  it('reads the goods receipts with quantities as numbers and billed from the receipt\'s own vendor bills', () => {
    const detail = purchaseOrderDetailFromNpi(body) as PurchaseOrderDetail;
    expect(detail.goodsReceipts).toEqual([
      { id: 'grn-3', code: 'GRN-00003', status: 'ACCEPTED', billed: false, lines: [{ purchaseOrderLineId: 'pl-1', qty: 8 }] },
      { id: 'grn-2', code: 'GRN-00002', status: 'ACCEPTED', billed: true, lines: [{ purchaseOrderLineId: 'pl-3', qty: 60.5 }] },
    ]);
  });

  it('treats missing arrays as empty and a missing status as null', () => {
    const detail = purchaseOrderDetailFromNpi({ id: 'po-8', code: 'PO-00008' }) as PurchaseOrderDetail;
    expect(detail).toEqual({ id: 'po-8', code: 'PO-00008', status: null, vendorId: null, currency: null, lines: [], goodsReceipts: [] });
    const noBills = purchaseOrderDetailFromNpi({ id: 'po-8', code: 'PO-00008', goodsReceipts: [{ id: 'g1', code: 'GRN-00001', status: 'DRAFT' }] }) as PurchaseOrderDetail;
    expect(noBills.goodsReceipts).toEqual([{ id: 'g1', code: 'GRN-00001', status: 'DRAFT', billed: false, lines: [] }]);
  });

  it('returns null for anything that is not a purchase-order record', () => {
    expect(purchaseOrderDetailFromNpi(null)).toBeNull();
    expect(purchaseOrderDetailFromNpi('PO-00007')).toBeNull();
    expect(purchaseOrderDetailFromNpi([])).toBeNull();
    expect(purchaseOrderDetailFromNpi({ id: 'po-7' })).toBeNull();
    expect(purchaseOrderDetailFromNpi({ code: 'PO-00007' })).toBeNull();
    expect(purchaseOrderDetailFromNpi({ id: 7, code: 'PO-00007' })).toBeNull();
  });
});

describe('purchaseOrderReceivable', () => {
  it('lists SENT and PARTIALLY_RECEIVED as the receivable statuses', () => {
    expect([...RECEIVABLE_PO_STATUSES]).toEqual(['SENT', 'PARTIALLY_RECEIVED']);
  });

  it.each([
    ['DRAFT', false],
    ['PENDING_APPROVAL', false],
    ['APPROVED', false],
    ['SENT', true],
    ['PARTIALLY_RECEIVED', true],
    ['RECEIVED', false],
    ['CLOSED', false],
    ['CANCELLED', false],
    [null, false],
  ] as const)('status %s → %s', (status, expected) => {
    expect(purchaseOrderReceivable({ status })).toBe(expected);
  });
});

// The seed-like PO-00007: 40 modules, 1 inverter, 120 m of rail, nothing received yet.
const PO_LINES: PoLineRef[] = [
  { id: 'pl-1', itemId: 'item-1', sku: 'MOD-550', nameAr: 'لوح شمسي 550 واط', nameEn: null, isSerialised: true, qty: 40, unitPrice: 320, receivedQty: 0 },
  { id: 'pl-2', itemId: 'item-2', sku: 'INV-50K', nameAr: 'عاكس 50 كيلوواط', nameEn: null, isSerialised: true, qty: 1, unitPrice: 6500, receivedQty: 0 },
  { id: 'pl-3', itemId: 'item-3', sku: 'MNT-RAIL', nameAr: 'قضيب تثبيت', nameEn: null, isSerialised: false, qty: 120, unitPrice: 18, receivedQty: 0 },
];

describe('resolvePoLine', () => {
  it('matches by SKU first, in any spelling, ahead of the name', () => {
    expect(resolvePoLine({ sku: 'MOD-550' }, PO_LINES)).toMatchObject({ kind: 'matched', by: 'sku', line: { id: 'pl-1' }, similarity: 1 });
    expect(resolvePoLine({ sku: 'inv-50k', name: 'لوح شمسي 550 واط' }, PO_LINES)).toMatchObject({ kind: 'matched', by: 'sku', line: { id: 'pl-2' } });
  });

  it('matches by name at or above 0.85 trigram similarity', () => {
    const exact = resolvePoLine({ name: 'لوح شمسي 550 واط' }, PO_LINES);
    expect(exact).toMatchObject({ kind: 'matched', by: 'name', line: { id: 'pl-1' } });
    if (exact.kind === 'matched') expect(exact.similarity).toBeGreaterThanOrEqual(0.85);
    // An unknown SKU falls through to the name.
    expect(resolvePoLine({ sku: 'XYZ-9', name: 'قضيب تثبيت' }, PO_LINES)).toMatchObject({ kind: 'matched', by: 'name', line: { id: 'pl-3' } });
    // Alef-maksura spelling folds to the same name.
    expect(resolvePoLine({ name: 'لوح شمسى 550 واط' }, PO_LINES)).toMatchObject({ kind: 'matched', by: 'name', line: { id: 'pl-1' } });
  });

  it('offers partial matches for choice instead of picking one', () => {
    const r = resolvePoLine({ name: 'قضيب تثبيت ألمنيوم' }, PO_LINES);
    expect(r.kind).toBe('candidates');
    if (r.kind !== 'candidates') return;
    expect(r.candidates[0].entity.id).toBe('pl-3');
    expect(r.candidates[0].similarity).toBeGreaterThanOrEqual(0.5);
    expect(r.candidates[0].similarity).toBeLessThan(0.85);

    const modules = resolvePoLine({ name: 'لوح شمسي' }, PO_LINES);
    expect(modules.kind).toBe('candidates');
  });

  it('says none when nothing is close or there is nothing to match on', () => {
    expect(resolvePoLine({ name: 'وصلة MC4 للألواح' }, PO_LINES)).toEqual({ kind: 'none' });
    expect(resolvePoLine({}, PO_LINES)).toEqual({ kind: 'none' });
    expect(resolvePoLine({ sku: '  ', name: '  ' }, PO_LINES)).toEqual({ kind: 'none' });
    expect(resolvePoLine({ sku: 'MOD-550' }, [])).toEqual({ kind: 'none' });
  });

  it('turns a tie at the top into candidates, not a match', () => {
    const twice: PoLineRef[] = [...PO_LINES, { ...PO_LINES[2], id: 'pl-4', itemId: 'item-4', qty: 60 }];
    const r = resolvePoLine({ name: 'قضيب تثبيت' }, twice);
    expect(r.kind).toBe('candidates');
    if (r.kind !== 'candidates') return;
    expect(r.candidates.map((c) => c.entity.id).sort()).toEqual(['pl-3', 'pl-4']);
  });
});

describe('receiptLineWarnings', () => {
  const partlyReceived: PoLineRef = { ...PO_LINES[0], receivedQty: 30 }; // 10 left

  it('flags a quantity above what is left on the PO line', () => {
    expect(receiptLineWarnings({ qty: 12, serials: serialList('GS550-2610', 1, 12) }, partlyReceived)).toEqual(['extract.warn.over_receipt']);
    expect(receiptLineWarnings({ qty: 41, serials: serialList('GS550-2610', 1, 41) }, PO_LINES[0])).toEqual(['extract.warn.over_receipt']);
  });

  it('accepts exactly what is left, and a fractional remainder', () => {
    expect(receiptLineWarnings({ qty: 10, serials: serialList('GS550-2610', 1, 10) }, partlyReceived)).toEqual([]);
    expect(receiptLineWarnings({ qty: 59.5, serials: [] }, { ...PO_LINES[2], receivedQty: 60.5 })).toEqual([]);
    expect(receiptLineWarnings({ qty: 60, serials: [] }, { ...PO_LINES[2], receivedQty: 60.5 })).toEqual(['extract.warn.over_receipt']);
  });

  it('flags a serialised item whose serial count is not the quantity', () => {
    expect(receiptLineWarnings({ qty: 4, serials: ['GS550-1', 'GS550-2', 'GS550-3'] }, PO_LINES[0])).toEqual(['extract.warn.serials_required']);
    expect(receiptLineWarnings({ qty: 5, serials: [] }, PO_LINES[0])).toEqual(['extract.warn.serials_required']);
    expect(receiptLineWarnings({ qty: 2, serials: ['GS550-1', 'GS550-2'] }, PO_LINES[0])).toEqual([]);
  });

  it('raises both warnings when both apply', () => {
    expect([...receiptLineWarnings({ qty: 12, serials: ['GS550-1'] }, partlyReceived)].sort()).toEqual(['extract.warn.over_receipt', 'extract.warn.serials_required']);
  });

  it('says nothing for a non-serialised line without serials', () => {
    expect(receiptLineWarnings({ qty: 60, serials: [] }, PO_LINES[2])).toEqual([]);
  });
});

describe('resolveGoodsReceipt', () => {
  const draft: GoodsReceiptRef = { id: 'grn-2', code: 'GRN-00002', status: 'DRAFT', billed: false, lines: [] };
  const accepted: GoodsReceiptRef = { id: 'grn-3', code: 'GRN-00003', status: 'ACCEPTED', billed: false, lines: [] };
  const billed: GoodsReceiptRef = { id: 'grn-1', code: 'GRN-00001', status: 'ACCEPTED', billed: true, lines: [] };

  it('matches by code numerically, so «GRN-3» finds GRN-00003', () => {
    expect(resolveGoodsReceipt({ code: 'GRN-3' }, [draft, accepted, billed])).toMatchObject({ kind: 'matched', by: 'code', receipt: { id: 'grn-3' } });
    expect(resolveGoodsReceipt({ code: 'grn-00003' }, [draft, accepted, billed])).toMatchObject({ kind: 'matched', by: 'code', receipt: { id: 'grn-3' } });
    expect(resolveGoodsReceipt({ code: 'GRN-٠٠٠٠٣' }, [draft, accepted, billed])).toMatchObject({ kind: 'matched', by: 'code', receipt: { id: 'grn-3' } });
  });

  it('finds a named receipt even when it cannot be billed — the blockers say why', () => {
    expect(resolveGoodsReceipt({ code: 'GRN-00001' }, [draft, accepted, billed])).toMatchObject({ kind: 'matched', by: 'code', receipt: { id: 'grn-1' } });
    expect(resolveGoodsReceipt({ code: 'GRN-2' }, [draft, accepted, billed])).toMatchObject({ kind: 'matched', by: 'code', receipt: { id: 'grn-2' } });
  });

  it('takes the only accepted, unbilled receipt when no code (or an unknown one) was given', () => {
    expect(resolveGoodsReceipt({}, [draft, accepted, billed])).toMatchObject({ kind: 'matched', by: 'only_billable', receipt: { id: 'grn-3' } });
    expect(resolveGoodsReceipt({ code: null }, [draft, accepted, billed])).toMatchObject({ kind: 'matched', by: 'only_billable', receipt: { id: 'grn-3' } });
    expect(resolveGoodsReceipt({ code: 'GRN-99' }, [draft, accepted, billed])).toMatchObject({ kind: 'matched', by: 'only_billable', receipt: { id: 'grn-3' } });
  });

  it('offers the billable receipts for choice when there are several', () => {
    const second: GoodsReceiptRef = { id: 'grn-4', code: 'GRN-00004', status: 'ACCEPTED', billed: false, lines: [] };
    const r = resolveGoodsReceipt({}, [draft, accepted, second, billed]);
    expect(r.kind).toBe('candidates');
    if (r.kind !== 'candidates') return;
    expect(r.candidates.map((c) => c.entity.id).sort()).toEqual(['grn-3', 'grn-4']);
    expect(r.candidates.every((c) => c.similarity === 1)).toBe(true);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
  });

  it('says none when every receipt is billed, not accepted, or there are none', () => {
    expect(resolveGoodsReceipt({}, [billed])).toEqual({ kind: 'none' });
    expect(resolveGoodsReceipt({}, [draft, billed])).toEqual({ kind: 'none' });
    expect(resolveGoodsReceipt({ code: 'GRN-3' }, [])).toEqual({ kind: 'none' });
    expect(resolveGoodsReceipt({}, [])).toEqual({ kind: 'none' });
  });
});

describe('goodsReceiptBlockers', () => {
  it('flags a receipt NPI has not accepted yet', () => {
    expect(goodsReceiptBlockers({ id: 'g', code: 'GRN-00003', status: 'DRAFT', billed: false, lines: [] })).toEqual(['extract.warn.grn_not_accepted']);
    expect(goodsReceiptBlockers({ id: 'g', code: 'GRN-00003', status: 'INSPECTED', billed: false, lines: [] })).toEqual(['extract.warn.grn_not_accepted']);
    expect(goodsReceiptBlockers({ id: 'g', code: 'GRN-00003', status: null, billed: false, lines: [] })).toEqual(['extract.warn.grn_not_accepted']);
  });

  it('flags a receipt that already has a bill', () => {
    expect(goodsReceiptBlockers({ id: 'g', code: 'GRN-00001', status: 'ACCEPTED', billed: true, lines: [] })).toEqual(['extract.warn.grn_billed']);
  });

  it('flags both for a billed receipt that was never accepted, and none for an accepted unbilled one', () => {
    expect([...goodsReceiptBlockers({ id: 'g', code: 'GRN-00005', status: 'DRAFT', billed: true, lines: [] })].sort()).toEqual(['extract.warn.grn_billed', 'extract.warn.grn_not_accepted']);
    expect(goodsReceiptBlockers({ id: 'g', code: 'GRN-00003', status: 'ACCEPTED', billed: false, lines: [] })).toEqual([]);
  });
});

describe('expectedBillAmounts', () => {
  const po: PurchaseOrderDetail = { id: 'po-7', code: 'PO-00007', status: 'RECEIVED', vendorId: 'ven-1', currency: 'SAR', lines: PO_LINES, goodsReceipts: [] };
  const receipt = (lines: { purchaseOrderLineId: string; qty: number }[]): GoodsReceiptRef => ({ id: 'grn-3', code: 'GRN-00003', status: 'ACCEPTED', billed: false, lines });

  it('applies NPI\'s formula to the seed-like receipt: 40×320 + 1×6500 + 120×18 = 21,460 + 3,219 VAT = 24,679', () => {
    const amounts = expectedBillAmounts(
      receipt([
        { purchaseOrderLineId: 'pl-1', qty: 40 },
        { purchaseOrderLineId: 'pl-2', qty: 1 },
        { purchaseOrderLineId: 'pl-3', qty: 120 },
      ]),
      po,
    );
    expect(amounts).toEqual({ subtotal: 21460, vatAmount: 3219, total: 24679 });
  });

  it('prices only what the receipt took, at the PO line price', () => {
    expect(expectedBillAmounts(receipt([{ purchaseOrderLineId: 'pl-1', qty: 8 }, { purchaseOrderLineId: 'pl-2', qty: 1 }]), po)).toEqual({ subtotal: 9060, vatAmount: 1359, total: 10419 });
  });

  it('lets a line id unknown to the PO contribute nothing', () => {
    expect(expectedBillAmounts(receipt([{ purchaseOrderLineId: 'pl-3', qty: 120 }, { purchaseOrderLineId: 'pl-x', qty: 5 }]), po)).toEqual({ subtotal: 2160, vatAmount: 324, total: 2484 });
    expect(expectedBillAmounts(receipt([{ purchaseOrderLineId: 'pl-x', qty: 5 }]), po)).toEqual({ subtotal: 0, vatAmount: 0, total: 0 });
    expect(expectedBillAmounts(receipt([]), po)).toEqual({ subtotal: 0, vatAmount: 0, total: 0 });
  });

  it('rounds each figure to two decimals and accepts another VAT rate', () => {
    const odd: PurchaseOrderDetail = { ...po, lines: [{ ...PO_LINES[2], unitPrice: 333.33, qty: 3 }] };
    expect(expectedBillAmounts(receipt([{ purchaseOrderLineId: 'pl-3', qty: 3 }]), odd)).toEqual({ subtotal: 999.99, vatAmount: 150, total: 1149.99 });
    expect(expectedBillAmounts(receipt([{ purchaseOrderLineId: 'pl-3', qty: 120 }]), po, 0)).toEqual({ subtotal: 2160, vatAmount: 0, total: 2160 });
  });
});

describe('billTotalWarnings', () => {
  const expected = { subtotal: 21460, total: 24679 };

  it('accepts a bill that matches, and one within the tolerance', () => {
    expect(billTotalWarnings({ subtotal: 21460, total: 24679 }, expected)).toEqual([]);
    expect(billTotalWarnings({ subtotal: 21500, total: 24700 }, expected)).toEqual([]);
  });

  it('flags a total (24,000 against 24,679) or a subtotal that differs beyond the tolerance', () => {
    expect(billTotalWarnings({ subtotal: 21460, total: 24000 }, expected)).toEqual(['extract.warn.bill_total_mismatch']);
    expect(billTotalWarnings({ subtotal: null, total: 24000 }, expected)).toEqual(['extract.warn.bill_total_mismatch']);
    expect(billTotalWarnings({ subtotal: 20000, total: null }, expected)).toEqual(['extract.warn.bill_total_mismatch']);
    const both = billTotalWarnings({ subtotal: 20000, total: 24000 }, expected);
    expect(both.length).toBeGreaterThan(0);
    expect(both.every((w) => w === 'extract.warn.bill_total_mismatch')).toBe(true);
  });

  it('says nothing about what the bill does not state', () => {
    expect(billTotalWarnings({ subtotal: null, total: null }, expected)).toEqual([]);
  });
});

// ─── 10. i18n ───────────────────────────────────────────────────────────────

describe('Arabic strings for the T-25 flows', () => {
  const warnings = [
    'extract.warn.serials_count',
    'extract.warn.serials_duplicate',
    'extract.warn.date_future',
    'extract.warn.over_receipt',
    'extract.warn.serials_required',
    'extract.warn.po_not_receivable',
    'extract.warn.grn_not_accepted',
    'extract.warn.grn_billed',
    'extract.warn.bill_total_mismatch',
  ];
  const keys = [...warnings, 'extract.incomplete.grn', 'extract.incomplete.vendor_bill'];

  it.each(keys)('has a non-empty entry for %s', (key) => {
    const value = (ar as Record<string, unknown>)[key];
    expect(typeof value).toBe('string');
    expect((value as string).trim().length).toBeGreaterThan(0);
  });

  it('keeps the document-code example in the incomplete messages', () => {
    expect((ar as Record<string, string>)['extract.incomplete.grn']).toContain('PO-00007');
  });
});
