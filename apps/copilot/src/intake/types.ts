// Shared shapes of an intake job as the browser sees it (T-26, F-10,
// spec/madar/02 §5.7-5.8, 03 §2 `PreviewCard`/`ExecutionCard`).
//
// This file is the contract between three places: the server that builds a
// preview (`src/intake/{job,preview,edit,resolution}.ts`), the client
// components that render it (`src/components/PreviewCard.tsx`,
// `ExecutionCard.tsx`, `intake/IntakePanel.tsx`) and the tests. It holds
// types only (plus string-literal unions) so a client bundle can import it
// with `import type` and never pull server code in.
//
// Everything here is JSON-serializable: `previewJson`, `extractedJson` and
// `executionLogJson` on `intake_jobs` store these shapes verbatim.
import type { FlowType } from '../agents/router';
import type { AssessedField, FieldWarning } from '../extract/schemas/field';
import type { ExtractUsage, SourceFlags } from '../extract/run';
import type { DocumentKind } from './upload';

export type { FlowType };

/** Mirrors the Prisma enum `IntakeStatus` (prisma/schema.prisma). T-26 moves
 *  a job through extracting → preview | failed → approved | cancelled;
 *  executing/done belong to T-27. */
export type IntakeStatus = 'extracting' | 'preview' | 'approved' | 'executing' | 'done' | 'failed' | 'cancelled';

// ─── What the model returned (intake_jobs.extractedJson) ───────────────────

export interface StoredExtraction {
  /** The flow schema's wire JSON, rehydrated (names in clear — this is the
   *  copilot's own database), after every edit applied so far. Re-assessed
   *  with `FLOWS[flow].assess` whenever the preview is rebuilt. */
  output: unknown;
  flags: SourceFlags;
  /** What the user typed with the document, or the whole sentence. */
  userHint: string | null;
  source: { kind: 'text' | 'vision'; pages: number };
  /** One entry per model call (the extraction, then each sentence edit). */
  usage: ExtractUsage[];
}

// ─── Entity resolution (intake_jobs.previewJson.resolution) ────────────────

/** One decision about an NPI entity the document names (02 §5.6, BR-09). */
export type EntityPick =
  | { kind: 'matched'; id: string; labelAr: string; by: 'vat' | 'name' | 'code' | 'sku' | 'only_billable' }
  | { kind: 'candidates'; candidates: { id: string; labelAr: string; similarity: number }[] }
  /** Not in NPI; may be created by the execution (customer, vendor, item). */
  | { kind: 'new' }
  /** Not in NPI and nothing to create (project, department, PO, GRN…). */
  | { kind: 'none' }
  /** NPI refused or could not serve the list; the value stays text. */
  | { kind: 'unreadable'; messageAr: string };

export interface LineResolution {
  item?: EntityPick;
  poLine?: EntityPick;
  wbs?: EntityPick;
  /** The item's `unitCost` from NPI (a PR line's estimated price). */
  unitCost?: number | null;
  /** Warnings the resolution adds to this line's fields (`over_receipt` on
   *  `qty`, `serials_required` on `serials`). */
  warnings: { field: string; warning: FieldWarning }[];
}

export interface FlowResolution {
  flow: FlowType;
  customer?: EntityPick;
  vendor?: EntityPick;
  project?: EntityPick;
  department?: EntityPick;
  requisition?: EntityPick;
  purchaseOrder?: EntityPick & { status?: string | null; receivable?: boolean };
  goodsReceipt?: EntityPick;
  /** Aligned by index with `values.lines` (usable lines only). */
  lines: LineResolution[];
  /** The bill amounts as NPI will compute them from the receipt (vendor_bill). */
  expectedBillAmounts?: { subtotal: number; vatAmount: number; total: number } | null;
  /** Warnings the resolution adds to header fields (`po_not_receivable` on
   *  `purchaseOrderCode`, `grn_billed` on `goodsReceiptCode`,
   *  `bill_total_mismatch` on `total`/`subtotal`…). */
  warnings: { path: string; warning: FieldWarning }[];
  /** Arabic sentences for the card's «ملاحظات المطابقة». */
  notesAr: string[];
}

// ─── The preview the card renders (intake_jobs.previewJson.model) ──────────

export type PreviewFieldKind = 'text' | 'number' | 'amount' | 'date' | 'code' | 'serials' | 'enum';

export interface PreviewField {
  /** Dotted path into the assessed tree («customer.nameAr», «lines.0.qty»). */
  path: string;
  labelAr: string;
  /** The typed value (`AssessedField.value`), null when absent. */
  value: string | number | string[] | null;
  /** What the card shows: formatted number, enum in Arabic, serials joined,
   *  «—» when null. */
  displayAr: string;
  status: 'confirmed' | 'unconfirmed';
  confidence: number;
  evidence: string | null;
  page: number | null;
  /** Arabic text of each warning (`t(warning)`). */
  warningsAr: string[];
  /** NPI cannot do without it (the flow's required paths). */
  required: boolean;
  /** Unconfirmed for a reason the user may simply vouch for (low
   *  confidence, a derived amount…) rather than a format NPI would reject. */
  confirmable: boolean;
  /** The user may type a new value inline (`set`). Always true for a leaf. */
  editable: boolean;
  kind: PreviewFieldKind;
}

export interface PreviewSection {
  key: string;
  titleAr: string;
  fields: PreviewField[];
}

export interface PreviewLineRow {
  index: number;
  titleAr: string;
  fields: PreviewField[];
}

/** A decision the user makes on the card: which NPI entity a name refers to,
 *  or «new». `target` is the key of the `choose` action:
 *  `customer` | `vendor` | `project` | `department` | `requisition` |
 *  `goodsReceipt` | `lines.<i>.item` | `lines.<i>.poLine` | `lines.<i>.wbs`. */
export interface PreviewChoice {
  target: string;
  promptAr: string;
  options: { id: string; labelAr: string }[];
  /** An option id, `'new'`, or null while undecided. */
  chosen: string | null;
}

export interface PreviewStep {
  n: number;
  labelAr: string;
}

export interface PreviewModel {
  flow: FlowType;
  flowLabelAr: string;
  sections: PreviewSection[];
  lines: { titleAr: string; rows: PreviewLineRow[] } | null;
  choices: PreviewChoice[];
  notesAr: string[];
  /** «ما سيُنفَّذ بالترتيب» — descriptive; T-27's plan performs them. */
  steps: PreviewStep[];
  /** `extract.incomplete[.flow]` when the extraction yielded no usable values. */
  incompleteAr: string | null;
  /** Why «اعتمد» is disabled, in Arabic; empty when `canApprove`. */
  blockersAr: string[];
  canApprove: boolean;
  summary: { total: number; confirmed: number; unconfirmed: number };
}

export interface StoredPreview {
  resolution: FlowResolution | null;
  /** `choose` decisions by target (an entity id or `'new'`). */
  choices: Record<string, string>;
  /** Paths the user confirmed or set by hand; shown confirmed on rebuild. */
  confirmed: string[];
  /** The assessed leaves the model was built from (for the trust screen and tests). */
  fields: Record<string, AssessedField<unknown>>;
  model: PreviewModel;
}

// ─── Execution (intake_jobs.executionLogJson) ───────────────────────────────

export type ExecutionStepState = 'pending' | 'running' | 'done' | 'failed';

export interface ExecutionStep {
  n: number;
  labelAr: string;
  state: ExecutionStepState;
  /** The NPI record this step created, once it has. `npiPath` is a path on
   *  NPI's web app (e.g. `/contracts/<id>`) for `npiWebUrl`. */
  entity?: { kindAr: string; id: string; code: string | null; npiPath: string | null };
  /** `NpiError.messageAr` of the failed step. */
  errorAr?: string;
}

/** T-26 writes `{ status: 'pending' }` on approve; T-27 drives the rest
 *  (ADR-29: stop on failure, no automatic retry of writes). */
export interface ExecutionLog {
  status: 'pending' | 'running' | 'done' | 'failed';
  steps: ExecutionStep[];
  /** For `failed`: the 1-based step that failed. */
  failedAt?: number;
  startedAt?: string;
  finishedAt?: string;
}

// ─── What the browser receives (`GET /copilot/api/intake?id=`) ─────────────

export interface IntakeDocumentView {
  id: string;
  fileName: string;
  kind: DocumentKind;
  pageCount: number;
}

export interface IntakeView {
  id: string;
  flow: FlowType;
  flowLabelAr: string;
  status: IntakeStatus;
  conversationId: string | null;
  document: IntakeDocumentView | null;
  /** Present once the extraction succeeded (status preview and after). */
  preview: PreviewModel | null;
  /** Present when status is `failed`. */
  failureAr: string | null;
  execution: ExecutionLog | null;
  createdAt: string;
  approvedAt: string | null;
}

/** `POST /copilot/api/intake` body. */
export type IntakeAction =
  | { id: string; action: 'confirm'; path: string }
  | { id: string; action: 'set'; path: string; value: string }
  | { id: string; action: 'choose'; target: string; choice: string }
  | { id: string; action: 'edit'; text: string }
  | { id: string; action: 'approve' }
  | { id: string; action: 'cancel' };
