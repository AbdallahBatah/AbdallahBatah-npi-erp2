// T-30 (F-13, ADR-18, spec/madar/01 §3 scenario 5, BR-07): the contract
// between the handover builder (`handover.ts`), the reassignment service
// (`reassign.ts`), the `/api/handover` route, the `/handover` page and the
// chat's seven-day guidance (`src/agents/context.ts`). Types only — no
// runtime code.
//
// A position is (NPI role, NPI department) inside one organization. When an
// administrator names a new holder, the copilot ends the current holders'
// assignments, opens one for the successor, and writes a handover document
// built from (1) what NPI's approval matrix is waiting on from that role,
// (2) the vendors and routines the firm's memory holds for the position, and
// (3) a short narrative the advanced-tier model writes from (1) and (2). The
// document is stored as `handover_docs.bodyJson` (this file's `HandoverBody`)
// plus `bodyAr`, its plain-text rendering.

/** NPI permission keys the builder needs, per read. A read the caller cannot
 *  make is skipped, never worked around (08 §E.10). */
export const HANDOVER_PERMISSION = {
  /** `GET /approvals/history` — `ApprovalsController.history`, `admin.approval.manage`. */
  approvals: 'admin.approval.manage',
  /** `GET /admin/roles` — role key → role id (`AdminController.listRoles`, `admin.user.manage`). */
  roles: 'admin.user.manage',
  /** `GET /admin/departments/directory` and `GET /admin/departments` — names
   *  of users and departments (`DepartmentsController`, `admin.department.manage`). */
  directory: 'admin.department.manage',
  /** `GET /procurement/vendors` — vendor names and codes (`ProcurementController.listVendors`, `scm.procurement.read`). */
  vendors: 'scm.procurement.read',
} as const;

/** The one permission that may reassign a position, list candidates, read
 *  every handover of the organization and read a predecessor's chats — the
 *  same key `/settings` and `/setup` guard with. */
export const HANDOVER_ADMIN_PERMISSION = 'admin.user.manage';

/** How long the successor's chat carries the handover guidance (01 §3: «إرشاد 7 أيام»). */
export const HANDOVER_GUIDANCE_DAYS = 7;

// ─── The document body (`handover_docs.bodyJson`) ────────────────────────────

/** One chain of NPI's approval matrix whose current step waits on the
 *  position's role — from `GET /approvals/history?status=PENDING`
 *  (`ApprovalRequestView`, apps/api/src/common/approval.service.ts:64-84). */
export interface HandoverTask {
  /** `ApprovalRequestView.id` */
  id: string;
  /** PURCHASE_REQUISITION | PURCHASE_ORDER | PROGRESS_CLAIM | CHANGE_ORDER */
  documentType: string;
  documentCode: string;
  /** `Number(row.amount)` on the wire — a number, not a Decimal string. */
  amount: number;
  /** 1-based index of the waiting step and the chain length. */
  currentStep: number;
  stepCount: number;
  /** ISO timestamp of `currentStepAt`. */
  waitingSince: string;
  raisedByNameAr: string | null;
  /** The waiting step's `escalatedAt` is set. */
  escalated: boolean;
}

export type HandoverSkipReason = 'no_permission' | 'npi_refused' | 'npi_error';

/** Why a section could not be read; a skipped section is shown as such,
 *  never as "nothing is waiting". */
export type HandoverSection<T> = { status: 'read'; items: T[] } | { status: 'skipped'; reason: HandoverSkipReason };

/** A vendor the position deals with, grouped from the memory facts that
 *  name it (`memory_facts.entityType = 'vendor'`, or a `recurring_item`
 *  fact's `valueJson.lastVendorId`). */
export interface HandoverVendor {
  /** NPI vendor id when the facts carry one; null for a chat fact about a vendor NPI does not list. */
  npiVendorId: string | null;
  /** From `GET /procurement/vendors` when readable; otherwise null. */
  nameAr: string | null;
  code: string | null;
  /** The sentences, as stored, most used first. */
  factsAr: string[];
}

/** A remembered sentence shown as is. */
export interface HandoverFact {
  factId: string;
  factAr: string;
  sourceType: 'npi' | 'chat';
}

export type HandoverNarrative =
  | {
      status: 'written';
      /** 2–4 sentences: what this position is responsible for right now. */
      summaryAr: string;
      /** 3–7 lines: what to do in the first week, most urgent first. */
      firstWeekAr: string[];
      /** 1–4 lines: what not to do (approvals happen in NPI's inbox, …). */
      cautionsAr: string[];
      modelId: string;
      writtenAt: string;
    }
  /** The model call failed or was refused; the administrator can retry («أعد كتابة الملخص»). */
  | { status: 'failed'; reason: string; failedAt: string }
  /** No narrative was requested (never the case for a reassignment; kept for a future import). */
  | { status: 'skipped' };

export interface HandoverPerson {
  npiUserId: string;
  /** From NPI's department directory when readable; null otherwise. */
  nameAr: string | null;
}

export interface HandoverBody {
  version: 1;
  /** ISO timestamp the body was built. */
  generatedAt: string;
  position: {
    id: string;
    roleKey: string;
    /** `Role.nameAr` from `/admin/roles` when readable, else null. */
    roleNameAr: string | null;
    departmentId: string | null;
    departmentNameAr: string | null;
    titleAr: string;
  };
  /** The holder whose assignment was ended by this reassignment, with the
   *  date it started; null when the position had no open holder. When the
   *  position had several open holders, the one with the latest `startedAt`. */
  predecessor: (HandoverPerson & { since: string }) | null;
  successor: HandoverPerson;
  /** Open chains waiting on the position's role, oldest first. NPI's matrix
   *  is role-scoped (approval.service.ts `inbox`, inbox.service.ts): the
   *  department is not a dimension of a chain on the wire, so a chain is
   *  listed for every position of that role. Workflow-engine tasks parked on
   *  a role have no organization-wide read endpoint (an NPI API gap — noted,
   *  not worked around) and are not listed. */
  tasks: HandoverSection<HandoverTask>;
  vendors: HandoverVendor[];
  /** Position-scoped memory (`scope = 'position'`, this position), most used first. */
  routines: HandoverFact[];
  /** Company-scoped NPI facts of the kinds a newcomer reads first
   *  (`customer_credit_terms`, `contract_payment_terms`, `active_project`), at most 15, most used first. */
  companyFacts: HandoverFact[];
  narrative: HandoverNarrative;
}

// ─── What the API returns ────────────────────────────────────────────────────

export interface HandoverSummary {
  id: string;
  positionId: string;
  positionTitleAr: string;
  fromUserId: string | null;
  toUserId: string;
  /** ISO */
  createdAt: string;
  narrativeStatus: HandoverNarrative['status'];
}

export interface PredecessorConversation {
  id: string;
  titleAr: string | null;
  /** ISO */
  updatedAt: string;
  messageCount: number;
}

export interface HandoverView extends HandoverSummary {
  body: HandoverBody;
  bodyAr: string;
  /** Present only for an administrator (BR-07): the predecessor's
   *  conversations held in this position, newest first. Absent (not empty)
   *  for the successor and the predecessor. */
  predecessorConversations?: PredecessorConversation[];
}

/** An NPI user an administrator may name as the new holder: active, with the
 *  position's role, and not holding it already. */
export interface HandoverCandidate {
  npiUserId: string;
  nameAr: string;
}

export interface HandoverCandidatesView {
  position: { id: string; titleAr: string; roleKey: string };
  holders: HandoverPerson[];
  candidates: HandoverCandidate[];
}

export type HandoverActionBody =
  | { action: 'reassign'; positionId: string; toUserId: string }
  /** Rewrites the narrative of an existing document from its stored body. */
  | { action: 'narrate'; id: string };

export interface ReassignOutcome {
  handoverId: string;
  /** Assignments ended by this reassignment (holders of the position, plus
   *  the successor's own open assignments on other positions of the same role). */
  endedAssignmentIds: string[];
  assignmentId: string;
  narrativeStatus: HandoverNarrative['status'];
}
