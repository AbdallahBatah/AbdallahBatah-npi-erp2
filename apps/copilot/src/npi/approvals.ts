// Runtime readers for the two NPI reads the handover document (T-30) needs
// beyond `admin.ts` / `directory.ts`: the approval matrix's control view
// (`GET /approvals/history`) and the vendor list (`GET /procurement/vendors`).
// Same discipline as `admin.ts`: NPI's OpenAPI document does not type these
// bodies, so the low-level client returns `unknown`, and every field read
// here is traced to the NPI source line that puts it on the wire. A field this
// file cannot trace is not read here.
//
// Money: `ApprovalRequestView.amount` is sent as a JSON number (NPI's
// `view()` calls `Number(row.amount)`), unlike a raw Prisma `Decimal`, which
// serializes as a string. The reader therefore accepts a finite number only —
// a string amount is a contract change worth failing loudly on, not coercing.
import { NpiError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unexpected(detail: string): never {
  throw new NpiError({ status: 0, kind: 'unexpected', npiMessage: null, devDetail: detail });
}

/** A date NPI serialized: Nest's JSON serialization of a `Date` is its ISO string. */
function readIso(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) {
    return unexpected(`${where}: missing/invalid ISO date`);
  }
  return value;
}

// ─── GET /approvals/history ──────────────────────────────────────────────────

export interface NpiApprovalChain {
  id: string;
  documentType: string;
  documentCode: string;
  amount: number;
  status: string;
  currentStep: number;
  currentStepAt: string;
  raisedBy: { id: string; nameAr: string } | null;
  steps: { sequence: number; status: string; roleId: string; roleNameAr: string; escalatedAt: string | null }[];
}

/**
 * `ApprovalsController.history` (apps/api/src/modules/approvals/approvals.controller.ts:90-105,
 * `@Get('history')`, `admin.approval.manage`, `take` capped at 200) returns
 * `ApprovalService.history` (apps/api/src/common/approval.service.ts:488-508):
 * `{ total, rows: rows.map((r) => this.view(r)) }`, newest chain first
 * (`orderBy: { createdAt: 'desc' }`). Every row is `view()` (lines 566-612),
 * typed `ApprovalRequestView` (lines 64-84):
 *  - id, documentType, documentCode   `ApprovalRequestView` lines 65-67 (view() 588-592)
 *  - amount                           line 593 (`amount: Number(row.amount)`) — a number
 *  - status                           `'PENDING' | 'APPROVED' | 'REJECTED'`
 *  - currentStep                      1-based sequence of the waiting step
 *  - currentStepAt                    `Date` → ISO string
 *  - raisedBy                         line 599 (`raisedBy: row.raisedBy`) — `{ id, nameAr, nameEn }` or null
 *    (`REQUEST_INCLUDE`, lines 104-113: `raisedBy: { select: { id, nameAr, nameEn } }`)
 *  - steps[]                          `row.steps.map(...)` (lines 600-610), ordered by `sequence`
 *    (`REQUEST_INCLUDE`): `sequence`, `status`, `role { id, nameAr, nameEn }`,
 *    `escalatedAt` (line 607, `Date | null`)
 * `decidedBy`, `decidedAt`, `note`, `closedAt`, `documentId` and `createdAt` are
 * on the wire too but not read here. `total` is the unpaginated count of the
 * filter (`prisma.approvalRequest.count({ where })`, line 499).
 */
export function readApprovalHistory(body: unknown): { total: number; rows: NpiApprovalChain[] } {
  if (!isRecord(body)) return unexpected('readApprovalHistory: body is not an object');
  const { total, rows } = body;
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    return unexpected('readApprovalHistory: missing/invalid "total"');
  }
  if (!Array.isArray(rows)) return unexpected('readApprovalHistory: missing/invalid "rows"');

  return {
    total,
    rows: rows.map((row, index): NpiApprovalChain => {
      const where = `readApprovalHistory.rows[${index}]`;
      if (!isRecord(row)) return unexpected(`${where}: element is not an object`);
      const { id, documentType, documentCode, amount, status, currentStep, currentStepAt, raisedBy, steps } = row;
      if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
      if (typeof documentType !== 'string') return unexpected(`${where}: missing/invalid "documentType"`);
      if (typeof documentCode !== 'string') return unexpected(`${where}: missing/invalid "documentCode"`);
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        return unexpected(`${where}: "amount" is not a finite number`);
      }
      if (typeof status !== 'string') return unexpected(`${where}: missing/invalid "status"`);
      if (typeof currentStep !== 'number' || !Number.isInteger(currentStep)) {
        return unexpected(`${where}: missing/invalid "currentStep"`);
      }
      const currentStepAtIso = readIso(currentStepAt, `${where}.currentStepAt`);

      let raiser: NpiApprovalChain['raisedBy'] = null;
      if (raisedBy !== null && raisedBy !== undefined) {
        if (!isRecord(raisedBy) || typeof raisedBy.id !== 'string' || typeof raisedBy.nameAr !== 'string') {
          return unexpected(`${where}: "raisedBy" present but not { id, nameAr }`);
        }
        raiser = { id: raisedBy.id, nameAr: raisedBy.nameAr };
      }

      if (!Array.isArray(steps)) return unexpected(`${where}: missing/invalid "steps"`);
      const readSteps = steps.map((step, stepIndex): NpiApprovalChain['steps'][number] => {
        const stepWhere = `${where}.steps[${stepIndex}]`;
        if (!isRecord(step)) return unexpected(`${stepWhere}: element is not an object`);
        const { sequence, status: stepStatus, role, escalatedAt } = step;
        if (typeof sequence !== 'number' || !Number.isInteger(sequence)) {
          return unexpected(`${stepWhere}: missing/invalid "sequence"`);
        }
        if (typeof stepStatus !== 'string') return unexpected(`${stepWhere}: missing/invalid "status"`);
        if (!isRecord(role) || typeof role.id !== 'string' || typeof role.nameAr !== 'string') {
          return unexpected(`${stepWhere}: missing/invalid "role"`);
        }
        return {
          sequence,
          status: stepStatus,
          roleId: role.id,
          roleNameAr: role.nameAr,
          escalatedAt:
            escalatedAt === null || escalatedAt === undefined ? null : readIso(escalatedAt, `${stepWhere}.escalatedAt`),
        };
      });

      return {
        id,
        documentType,
        documentCode,
        amount,
        status,
        currentStep,
        currentStepAt: currentStepAtIso,
        raisedBy: raiser,
        steps: readSteps,
      };
    }),
  };
}

/**
 * The chains whose waiting step is the given role's: the chain is `PENDING`,
 * and the step whose `sequence` equals `currentStep` exists, is `PENDING` and
 * belongs to `roleId`. (A department is not on the wire for a chain, so this
 * is role-scoped — see `HandoverBody.tasks` in handover-types.ts.)
 */
export function waitingOnRole(rows: readonly NpiApprovalChain[], roleId: string): NpiApprovalChain[] {
  return rows.filter((row) => {
    if (row.status !== 'PENDING') return false;
    const step = row.steps.find((s) => s.sequence === row.currentStep);
    return step !== undefined && step.status === 'PENDING' && step.roleId === roleId;
  });
}

// ─── GET /procurement/vendors ────────────────────────────────────────────────

export interface NpiVendorBrief {
  id: string;
  code: string;
  nameAr: string;
}

/**
 * `ProcurementController.listVendors` (apps/api/src/modules/procurement/procurement.controller.ts:24-28,
 * `@Get('vendors')`, `scm.procurement.read`) returns
 * `ProcurementService.listVendors` (procurement.service.ts:90-96), which is
 * `this.prisma.vendor.findMany({ where, include: { _count: ... }, orderBy: { code: 'asc' } })`
 * — a **bare JSON array** of full `Vendor` rows (not a `{ rows, total }`
 * envelope; `readList` in responses.ts documents the same). Fields off
 * `model Vendor` (packages/db/prisma/schema.prisma):
 *  - id      line 863 (`id             String   @id @default(cuid())`)
 *  - code    line 866 (`code           String`)
 *  - nameAr  line 867 (`nameAr         String`)
 * Everything else (`nameEn`, tax and contact columns, `_count`) is not read.
 */
export function readVendorsBrief(body: unknown): NpiVendorBrief[] {
  if (!Array.isArray(body)) return unexpected('readVendorsBrief: body is not an array');
  return body.map((row, index): NpiVendorBrief => {
    const where = `readVendorsBrief[${index}]`;
    if (!isRecord(row)) return unexpected(`${where}: element is not an object`);
    const { id, code, nameAr } = row;
    if (typeof id !== 'string') return unexpected(`${where}: missing/invalid "id"`);
    if (typeof code !== 'string') return unexpected(`${where}: missing/invalid "code"`);
    if (typeof nameAr !== 'string') return unexpected(`${where}: missing/invalid "nameAr"`);
    return { id, code, nameAr };
  });
}
