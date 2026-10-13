// Typed HTTP client for NPI's own API, called as the logged-in user (Bearer
// JWT of that user). The copilot has no database access to NPI and no
// admin/service token — every read and write here goes through NPI's HTTP
// surface exactly as NPI's own web client would use it, and is subject to
// the same permission checks NPI enforces for that user's role.
//
// FORBIDDEN BY DESIGN — this file must never grow a call that decides an
// approval request, or approves, rejects, or returns a workflow document, or
// issues any DELETE request, or creates/updates/deactivates a user or resets
// a password. The one user-level write is the permission-override set
// (`PUT` on a user's permissions, D-26 2026-10-13): it replaces the user's
// per-user exceptions as a whole, only after the administrator's own «اعتمد»
// on the preview card; it never touches the user record, the role or the
// password. Approving and rejecting happen only in NPI's own inbox UI; the
// copilot has no delete tools. `submitRequisition` below hard-codes its
// action code and does not accept an arbitrary action string, on purpose.
// Likewise no call to NPI's approve, decide, match or send endpoints: those are
// approvals and decisions (or the three-way match) that stay on NPI's own
// screens. (tests/npi-client.spec.ts greps this file for the literal paths, so
// they are not spelled out here.)
//
// The admin *configuration* writes under "admin configuration" (departments,
// roles' permission sets, approval-rule bands, catalog items) exist for one
// caller only — the onboarding apply step (`src/onboarding/apply.ts`,
// spec/madar/02 §7) — and run, like everything else here, as the logged-in
// administrator with that user's own JWT, after the dry-run diff was shown.
import type { components, paths } from './types';
import { mapNpiError, networkError, timeoutError } from './errors';
import { stripTrailingSlashes } from './base-url';

export interface CreateNpiClientOptions {
  /** Defaults to `NPI_API_BASE`, then `http://localhost:4000/api`. Already
   *  includes NPI's `/api` prefix — every path below is relative to it. */
  baseUrl?: string;
  /** The logged-in user's Bearer JWT. Sent on every call except `login`. */
  token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request abort timeout. Defaults to 10s. */
  timeoutMs?: number;
}

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Only `login` sets this — it is the one call with no user token yet. */
  skipAuth?: boolean;
  /** A multipart body (file upload). Passed to `fetch` untouched and with no
   *  `Content-Type` header, so `fetch` adds the multipart boundary itself. */
  form?: FormData;
}

function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const url = new URL(stripTrailingSlashes(baseUrl) + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * The one place every request goes through. No automatic retry of any kind,
 * ever — a failed request is reported to the caller, not silently re-sent.
 */
async function request(
  ctx: Required<Omit<CreateNpiClientOptions, 'baseUrl'>> & { baseUrl: string },
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!opts.skipAuth) headers.Authorization = `Bearer ${ctx.token}`;
  if (opts.form === undefined && opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);

  let res: Response;
  try {
    res = await ctx.fetchImpl(buildUrl(ctx.baseUrl, path, opts.query), {
      method,
      headers,
      body: opts.form !== undefined ? opts.form : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw timeoutError();
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) throw mapNpiError(res.status, parsed);
  return parsed;
}

export function createNpiClient(options: CreateNpiClientOptions) {
  const ctx = {
    baseUrl: options.baseUrl ?? process.env.NPI_API_BASE ?? 'http://localhost:4000/api',
    token: options.token,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 10_000,
  };

  return {
    // ── auth ──────────────────────────────────────────────────────────────

    /** The one call with no Bearer token — the token doesn't exist yet. */
    login(dto: components['schemas']['LoginDto']) {
      return request(ctx, 'POST', '/auth/login', { body: dto, skipAuth: true });
    },

    me() {
      return request(ctx, 'GET', '/auth/me');
    },

    // ── reads ─────────────────────────────────────────────────────────────

    listCustomers(search?: paths['/api/customers']['get']['parameters']['query']['search']) {
      return request(ctx, 'GET', '/customers', { query: { search } });
    },

    getCustomer(id: string) {
      return request(ctx, 'GET', `/customers/${encodeURIComponent(id)}`);
    },

    listProjects() {
      return request(ctx, 'GET', '/projects');
    },

    /** One project with its `wbsElements` (NPI has no WBS list endpoint). */
    getProject(id: string) {
      return request(ctx, 'GET', `/projects/${encodeURIComponent(id)}`);
    },

    /** One requisition with its `lines` (the line ids a conversion prices by). */
    getRequisition(id: string) {
      return request(ctx, 'GET', `/requisitions/${encodeURIComponent(id)}`);
    },

    listItems(search?: paths['/api/items']['get']['parameters']['query']['search']) {
      return request(ctx, 'GET', '/items', { query: { search } });
    },

    listVendors() {
      return request(ctx, 'GET', '/procurement/vendors');
    },

    // Pick lists (ADR-02 §3-3): names only, for matching the names a document
    // gives. Each is open to a holder of ANY key in its row of NPI's
    // `LOOKUP_ACCESS` (packages/shared/src/lookups.ts) — the owning screen's
    // read key, or the working key of a form that needs the list — so a 403
    // here means the user may neither open that screen nor fill such a form.

    /**
     * `GET /reference/lookups/items` — a bare array of `{ id, sku, nameAr,
     * nameEn, uom, isSerialised, unitCost }`, `unitCost` nulled by NPI for a
     * caller without `finance.costs.view` (as on `GET /items`). A
     * requisition writer reads it without `commercial.item.read`.
     */
    lookupItems() {
      return request(ctx, 'GET', '/reference/lookups/items');
    },

    /**
     * `GET /reference/lookups/projects` — a bare array of `{ id, code, nameAr,
     * nameEn }`, for `projects.project.read` or `scm.procurement.write`. No
     * WBS elements: those stay on `getProject`, behind the projects screen.
     */
    lookupProjects() {
      return request(ctx, 'GET', '/reference/lookups/projects');
    },

    listContracts() {
      return request(ctx, 'GET', '/contracts');
    },

    listRequisitions(query?: { status?: string; take?: number; skip?: number }) {
      return request(ctx, 'GET', '/requisitions', {
        query: { status: query?.status, take: query?.take, skip: query?.skip },
      });
    },

    listPurchaseOrders() {
      return request(ctx, 'GET', '/procurement/purchase-orders');
    },

    getPurchaseOrder(id: string) {
      return request(ctx, 'GET', `/procurement/purchase-orders/${encodeURIComponent(id)}`);
    },

    inboxTasks() {
      return request(ctx, 'GET', '/inbox/tasks');
    },

    inboxCount() {
      return request(ctx, 'GET', '/inbox/count');
    },

    /**
     * The control view of the approval matrix: every chain the organization
     * opened, filterable by status — NPI's `ApprovalsController.history`
     * (`@Get('history')`, `admin.approval.manage`). Read-only; the copilot
     * uses it (T-30) to list what is waiting on a *position's* role when a
     * holder changes, since `/inbox/tasks` only ever shows the caller's own.
     */
    listApprovalHistory(query?: { status?: string; documentType?: string; take?: number; skip?: number }) {
      return request(ctx, 'GET', '/approvals/history', {
        query: { status: query?.status, documentType: query?.documentType, take: query?.take, skip: query?.skip },
      });
    },

    listDepartments() {
      return request(ctx, 'GET', '/admin/departments');
    },

    /** People picker behind NPI's department screen; carries each user's
     *  `departmentId`. Needs `admin.department.manage`, like `listDepartments`. */
    listDepartmentDirectory() {
      return request(ctx, 'GET', '/admin/departments/directory');
    },

    listRoles() {
      return request(ctx, 'GET', '/admin/roles');
    },

    listPermissions() {
      return request(ctx, 'GET', '/admin/permissions');
    },

    listApprovalRules() {
      return request(ctx, 'GET', '/approvals/rules');
    },

    // D-26 (T-48a): reads behind the get_contract, finance_summary and
    // get_user_permissions chat tools. `listContracts` (above) is the sixth.

    /** `GET /contracts/:id` — a contract with its milestones; needs `commercial.contract.read`. */
    getContract(id: string) {
      return request(ctx, 'GET', `/contracts/${encodeURIComponent(id)}`);
    },

    /** `GET /finance/summary` — issued invoices, receivables, output VAT, retention; needs `finance.invoice.read`. */
    financeSummary() {
      return request(ctx, 'GET', '/finance/summary');
    },

    /** `GET /reference/dashboard` — CRM counters and pipeline value; needs `crm.lead.read`. */
    crmDashboard() {
      return request(ctx, 'GET', '/reference/dashboard');
    },

    /** `GET /admin/permissions` — the permission catalog with Arabic labels; needs `admin.user.manage`. */
    permissionCatalog() {
      return request(ctx, 'GET', '/admin/permissions');
    },

    /** One user's roles, overrides and effective permissions; needs `admin.user.manage`. */
    getUserPermissions(id: string) {
      return request(ctx, 'GET', `/admin/users/${encodeURIComponent(id)}/permissions`);
    },

    // ── writes (creation only — see the file-top note on what is deliberately
    //    missing from this client) ───────────────────────────────────────────

    createCustomer(dto: components['schemas']['CreateCustomerDto']) {
      return request(ctx, 'POST', '/customers', { body: dto });
    },

    createContract(dto: components['schemas']['CreateContractDto']) {
      return request(ctx, 'POST', '/contracts', { body: dto });
    },

    /** `POST /procurement/vendors` — a vendor the document names and NPI lacks. */
    createVendor(dto: components['schemas']['CreateVendorDto']) {
      return request(ctx, 'POST', '/procurement/vendors', { body: dto });
    },

    createRequisition(dto: components['schemas']['CreateRequisitionDto']) {
      return request(ctx, 'POST', '/requisitions', { body: dto });
    },

    /**
     * The requisition workflow's `/actions` route accepts any action code the
     * engine's transition table allows for the caller's role (see
     * apps/api/src/modules/procurement/requisitions.controller.ts, the `act`
     * method). This wrapper hard-codes the action to submission on purpose —
     * it does not take an action code from its caller — so this client can
     * never be used to move a requisition through a signature step.
     */
    submitRequisition(id: string, comment?: string) {
      const body: components['schemas']['WorkflowActionDto'] = { action: 'SUBMIT', comment };
      return request(ctx, 'POST', `/requisitions/${encodeURIComponent(id)}/actions`, { body });
    },

    createPurchaseOrder(dto: components['schemas']['CreatePoDto']) {
      return request(ctx, 'POST', '/procurement/purchase-orders', { body: dto });
    },

    receiveOnPurchaseOrder(poId: string, dto: components['schemas']['ReceiveDto']) {
      return request(ctx, 'POST', `/procurement/purchase-orders/${encodeURIComponent(poId)}/receive`, {
        body: dto,
      });
    },

    createBill(dto: components['schemas']['CreateBillDto']) {
      return request(ctx, 'POST', '/procurement/bills', { body: dto });
    },

    /**
     * `POST /requisitions/{id}/convert` — creates a purchase order (DRAFT, with
     * its workflow instance) from an APPROVED requisition, under
     * `scm.procurement.write`. NPI itself refuses any other status; this is a
     * creation, not an approval. `prices` are keyed by requisition line id.
     */
    convertRequisition(id: string, dto: components['schemas']['ConvertToPoDto']) {
      return request(ctx, 'POST', `/requisitions/${encodeURIComponent(id)}/convert`, { body: dto });
    },

    /**
     * `POST /attachments/{entityType}/{entityId}` as multipart (field `file`).
     * `entityType` is the literal `'contract'` on purpose (D-T27-4): NPI's
     * `AttachmentEntity` enum has CONTRACT, INVOICE, PROJECT and WORK_ORDER
     * only — no purchase order, receipt, bill or requisition — so the copilot
     * attaches a source document to a contract and nothing else.
     */
    attachFile(entityType: 'contract', entityId: string, file: { fileName: string; mime: string; bytes: Uint8Array }) {
      const form = new FormData();
      form.append('file', new Blob([file.bytes as BlobPart], { type: file.mime }), file.fileName);
      return request(ctx, 'POST', `/attachments/${entityType}/${encodeURIComponent(entityId)}`, { form });
    },

    // ── user permissions (D-26, T-48b) ───────────────────────────────────────

    /**
     * `PUT /admin/users/:id/permissions` — REPLACES the user's whole set of
     * per-user permission overrides (`[]` clears it); needs `admin.user.manage`
     * (apps/api/src/modules/admin/admin.controller.ts:72-80). NPI keeps the
     * "last administrator" rule (400) and writes the audit row. The caller is
     * the executor, after the preview card was approved.
     */
    setUserPermissions(id: string, dto: SetUserPermissionsDto) {
      return request(ctx, 'PUT', `/admin/users/${encodeURIComponent(id)}/permissions`, { body: dto });
    },

    // ── admin configuration (onboarding apply only — see the file-top note) ──

    /** `POST /admin/departments` — needs `admin.department.manage`. */
    createDepartment(dto: components['schemas']['CreateDepartmentDto']) {
      return request(ctx, 'POST', '/admin/departments', { body: dto });
    },

    /** `POST /admin/roles` — needs `admin.user.manage`. */
    createRole(dto: components['schemas']['CreateRoleDto']) {
      return request(ctx, 'POST', '/admin/roles', { body: dto });
    },

    /** `PATCH /admin/roles/:id` — needs `admin.user.manage`. Used only to set
     *  a role's permission set; names are not changed by the onboarding. */
    updateRole(id: string, dto: components['schemas']['UpdateRoleDto']) {
      return request(ctx, 'PATCH', `/admin/roles/${encodeURIComponent(id)}`, { body: dto });
    },

    /** `POST /approvals/rules` — needs `admin.approval.manage`. */
    createApprovalRule(dto: components['schemas']['CreateApprovalRuleDto']) {
      return request(ctx, 'POST', '/approvals/rules', { body: dto });
    },

    /** `PATCH /approvals/rules/:id` — needs `admin.approval.manage`. */
    updateApprovalRule(id: string, dto: components['schemas']['UpdateApprovalRuleDto']) {
      return request(ctx, 'PATCH', `/approvals/rules/${encodeURIComponent(id)}`, { body: dto });
    },

    /** `POST /items` — needs `commercial.item.write`. */
    createItem(dto: CreateItemDto) {
      return request(ctx, 'POST', '/items', { body: dto });
    },
  };
}

/**
 * `CreateItemDto` as NPI actually validates it. The generated type
 * (`components['schemas']['CreateItemDto']`) renders `itemCategory` as
 * `Record<string, never>` because NPI's OpenAPI document does not carry the
 * `@IsEnum(ITEM_CATEGORIES)` constraint; the real field is one of the seven
 * `ItemCategory` values (apps/api/src/modules/commercial/dto.ts:14,23). Every
 * other field is taken from the generated type unchanged.
 */
export type CreateItemDto = Omit<components['schemas']['CreateItemDto'], 'itemCategory'> & {
  itemCategory: 'MODULE' | 'INVERTER' | 'MOUNTING' | 'CABLE' | 'BOS' | 'SPARE' | 'SERVICE';
};

/**
 * The permission-override DTOs as NPI validates them
 * (apps/api/src/modules/admin/dto.ts:82-105). The generated `src/npi/types.ts`
 * predates the permission model (P1-3) and lacks them.
 */
export interface PermissionOverrideDto {
  permission: string;
  effect: 'GRANT' | 'DENY';
  /** Optional, at most 500 characters; blank counts as none. */
  reason?: string | null;
}

export interface SetUserPermissionsDto {
  overrides: PermissionOverrideDto[];
}

export type NpiClient = ReturnType<typeof createNpiClient>;
