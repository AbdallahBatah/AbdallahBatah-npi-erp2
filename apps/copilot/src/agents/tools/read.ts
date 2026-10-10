// Read-only tools the assistant may call during a chat turn.
//
// Every tool reads through NPI's HTTP API with the logged-in user's own token
// (`src/npi/client.ts`), so NPI's permission guard decides what this user may
// see: a 403 from NPI comes back to the model as a failed tool result and is
// relayed to the user, never worked around. `memory_search` is the one tool
// that reads the copilot's own database.
//
// There is deliberately no tool here that writes, approves, rejects or
// deletes. Writes are proposed only through intake jobs (preview card, then
// the user's own «اعتمد»), and approvals happen only in NPI's inbox.
//
// Money: NPI serializes Decimal columns as strings. They are passed through
// as strings and never parsed into a JavaScript number.
import { z } from 'zod';
import type { ToolDef } from '../../llm/provider';
import { searchFacts, type FactSearchDb } from '../../memory/fts';
import type { NpiClient } from '../../npi/client';
import { readList } from '../../npi/responses';
import { normalizeArabic } from '../../text/normalize';

export interface ToolContext {
  npi: Pick<
    NpiClient,
    | 'listCustomers'
    | 'listProjects'
    | 'inboxTasks'
    | 'listPurchaseOrders'
    | 'getPurchaseOrder'
    | 'listItems'
  >;
  db: FactSearchDb;
  npiOrgId: string;
  positionId: string | null;
  /** The caller's NPI permissions: memory facts are filtered by them (D-17). */
  permissions: readonly string[];
}

export interface MemoryNote {
  id: string;
  factAr: string;
  sourceType: 'npi' | 'chat';
}

export interface ToolOutcome {
  /** What goes back to the model (redacted by the caller before it leaves). */
  result: unknown;
  /** Facts that came from memory, shown to the user as «ملاحظة من الذاكرة». */
  memoryNotes?: MemoryNote[];
}

export interface ReadTool {
  def: ToolDef;
  /** Arabic label shown on the reply (the AssistantBadge). */
  badgeAr: string;
  /**
   * Fields of the result that hold a name or an identifier, with the
   * placeholder label each is masked under. They are masked as whole values
   * before the result goes to the model, so nothing depends on the value
   * being in the dictionary or matching a pattern.
   */
  sensitiveFields?: Readonly<Record<string, string>>;
  run(input: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Thrown for input the model sent that does not match the tool's schema. */
export class ToolInputError extends Error {}

const MAX_ROWS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A Decimal from NPI (string on the wire) or a plain number column. */
function amount(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error));
  return parsed.data;
}

function rows(body: unknown): Record<string, unknown>[] {
  return readList(body).filter(isRecord);
}

// ─── get_customer ───────────────────────────────────────────────────────────

const getCustomerInput = z.object({ query: z.string().trim().min(1).max(120) });

/**
 * Fields: NPI returns the raw Customer row
 * (apps/api/src/modules/crm/customers.service.ts:16 `list`), columns per
 * packages/db/prisma/schema.prisma:335-349.
 */
const getCustomer: ReadTool = {
  badgeAr: 'العملاء',
  sensitiveFields: { nameAr: 'عميل', vatNumber: 'رقم_ضريبي', phone: 'هاتف', email: 'بريد' },
  def: {
    name: 'get_customer',
    description:
      'Find customers in NPI by name or code. Returns up to 10 matches with code, Arabic name, VAT number, credit terms in days, phone and e-mail. Use it before answering anything about a customer.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Customer name or code, as the user wrote it.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const { query } = parse(getCustomerInput, input);
    const found = rows(await ctx.npi.listCustomers(query)).slice(0, MAX_ROWS);
    return {
      result: {
        count: found.length,
        customers: found.map((c) => ({
          code: str(c.code),
          nameAr: str(c.nameAr),
          vatNumber: str(c.vatNumber),
          creditTermsDays: typeof c.creditTermsDays === 'number' ? c.creditTermsDays : null,
          phone: str(c.phone),
          email: str(c.email),
        })),
      },
    };
  },
};

// ─── list_projects ──────────────────────────────────────────────────────────

const listProjectsInput = z.object({ query: z.string().trim().max(120).optional() });

/**
 * Fields: apps/api/src/modules/projects/projects.service.ts:43 `list`
 * (Project row + `contract { code, totalValue, customer { nameAr } }`).
 * NPI has no search parameter on this route, so filtering happens here.
 */
const listProjects: ReadTool = {
  badgeAr: 'المشاريع',
  sensitiveFields: { nameAr: 'مشروع', customerNameAr: 'عميل' },
  def: {
    name: 'list_projects',
    description:
      'List projects in NPI, optionally filtered by a project code or name. Returns up to 10 projects with code, Arabic name, stage, contract code and customer name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional project code (e.g. PRJ-00012) or part of its name.' },
      },
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const { query } = parse(listProjectsInput, input ?? {});
    const needle = query ? normalizeArabic(query) : '';
    const all = rows(await ctx.npi.listProjects());
    const matched = needle
      ? all.filter((p) =>
          [p.code, p.nameAr, p.nameEn].some(
            (field) => typeof field === 'string' && normalizeArabic(field).includes(needle),
          ),
        )
      : all;
    return {
      result: {
        count: matched.length,
        projects: matched.slice(0, MAX_ROWS).map((p) => {
          const contract = isRecord(p.contract) ? p.contract : {};
          const customer = isRecord(contract.customer) ? contract.customer : {};
          return {
            code: str(p.code),
            nameAr: str(p.nameAr),
            stage: str(p.stage),
            contractCode: str(contract.code),
            customerNameAr: str(customer.nameAr),
          };
        }),
      },
    };
  },
};

// ─── list_open_tasks ────────────────────────────────────────────────────────

/**
 * Fields: `InboxTask` in apps/api/src/modules/inbox/inbox.service.ts:8-27.
 * The list is already scoped by NPI to the caller's own role.
 */
const listOpenTasks: ReadTool = {
  badgeAr: 'صندوق المهام',
  def: {
    name: 'list_open_tasks',
    description:
      "List the tasks waiting for this user in NPI's inbox (approvals and workflow tasks), oldest first. The assistant can only list them: approving or rejecting happens in NPI's inbox screen, never in the chat.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(_input, ctx) {
    const tasks = rows(await ctx.npi.inboxTasks());
    return {
      result: {
        count: tasks.length,
        tasks: tasks.slice(0, 20).map((t) => ({
          documentType: str(t.documentType),
          documentCode: str(t.documentCode),
          titleAr: str(t.titleAr),
          stateAr: str(t.stateAr),
          amount: amount(t.amount),
          ageHours: typeof t.ageHours === 'number' ? t.ageHours : null,
          overdue: t.overdue === true,
          actionable: t.actionable !== false,
        })),
      },
    };
  },
};

// ─── get_po ─────────────────────────────────────────────────────────────────

const getPoInput = z.object({ code: z.string().trim().min(1).max(40) });

/**
 * NPI has no lookup by code, so the list is read first
 * (apps/api/src/modules/procurement/procurement.service.ts:132 `listPos`) and
 * the match is then read in full (`getPo`, same file :144).
 */
const getPo: ReadTool = {
  badgeAr: 'أوامر الشراء',
  sensitiveFields: { vendorNameAr: 'مورد' },
  def: {
    name: 'get_po',
    description:
      'Read one purchase order from NPI by its code (e.g. PO-00042): status, vendor, project, totals, lines with ordered and received quantities, and the codes and statuses of its goods receipts and vendor bills.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Purchase order code, e.g. PO-00042.' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const { code } = parse(getPoInput, input);
    const wanted = code.toUpperCase();
    const match = rows(await ctx.npi.listPurchaseOrders()).find(
      (po) => typeof po.code === 'string' && po.code.toUpperCase() === wanted,
    );
    const id = match ? str(match.id) : null;
    if (!id) return { result: { found: false, code } };

    const po = await ctx.npi.getPurchaseOrder(id);
    if (!isRecord(po)) return { result: { found: false, code } };
    const vendor = isRecord(po.vendor) ? po.vendor : {};
    const project = isRecord(po.project) ? po.project : {};
    const list = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);

    return {
      result: {
        found: true,
        code: str(po.code),
        status: str(po.status),
        vendorNameAr: str(vendor.nameAr),
        projectCode: str(project.code),
        currency: str(po.currency),
        subtotal: amount(po.subtotal),
        vatAmount: amount(po.vatAmount),
        total: amount(po.total),
        lines: list(po.lines).map((line) => {
          const item = isRecord(line.item) ? line.item : {};
          return {
            sku: str(item.sku),
            itemNameAr: str(item.nameAr),
            uom: str(item.uom),
            qty: amount(line.qty),
            receivedQty: amount(line.receivedQty),
            unitPrice: amount(line.unitPrice),
            lineTotal: amount(line.lineTotal),
          };
        }),
        goodsReceipts: list(po.goodsReceipts).map((g) => ({ code: str(g.code), status: str(g.status) })),
        vendorBills: list(po.vendorBills).map((b) => ({
          code: str(b.code),
          status: str(b.status),
          total: amount(b.total),
        })),
      },
    };
  },
};

// ─── search_items ───────────────────────────────────────────────────────────

const searchItemsInput = z.object({ query: z.string().trim().min(1).max(120) });

/** Fields: apps/api/src/modules/commercial/items.service.ts:10 `list`. */
const searchItems: ReadTool = {
  badgeAr: 'الأصناف',
  def: {
    name: 'search_items',
    description:
      'Search the NPI item catalogue by name or SKU. Returns up to 10 items with SKU, Arabic name, unit of measure, category and catalogue unit cost.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Item name or SKU.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const { query } = parse(searchItemsInput, input);
    const found = rows(await ctx.npi.listItems(query)).slice(0, MAX_ROWS);
    return {
      result: {
        count: found.length,
        items: found.map((i) => ({
          sku: str(i.sku),
          nameAr: str(i.nameAr),
          uom: str(i.uom),
          category: str(i.itemCategory),
          unitCost: amount(i.unitCost),
        })),
      },
    };
  },
};

// ─── memory_search ──────────────────────────────────────────────────────────

const memorySearchInput = z.object({ query: z.string().trim().min(1).max(200) });

const memorySearch: ReadTool = {
  badgeAr: 'الذاكرة',
  def: {
    name: 'memory_search',
    description:
      "Search the firm's memory: payment terms of customers and vendors, recurring items, preferences and notes learned from NPI data and earlier conversations. Use it for questions such as a customer's payment terms. A fact you use from here must be presented to the user as a note from memory.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for, in the user\'s words.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const { query } = parse(memorySearchInput, input);
    const hits = await searchFacts(ctx.db, {
      npiOrgId: ctx.npiOrgId,
      positionId: ctx.positionId,
      query,
      permissions: ctx.permissions,
      limit: 5,
    });
    return {
      result: {
        count: hits.length,
        facts: hits.map((h) => ({
          fact: h.factAr,
          about: h.entityType,
          source: h.sourceType,
          confidence: h.confidence,
        })),
      },
      memoryNotes: hits.map((h) => ({ id: h.id, factAr: h.factAr, sourceType: h.sourceType })),
    };
  },
};

export const READ_TOOLS: readonly ReadTool[] = [
  getCustomer,
  listProjects,
  listOpenTasks,
  getPo,
  searchItems,
  memorySearch,
];

export function findReadTool(name: string): ReadTool | undefined {
  return READ_TOOLS.find((tool) => tool.def.name === name);
}
