/**
 * Enum option lists with paired Arabic/English labels.
 * These mirror the Prisma enums (packages/db) but live here so both the API
 * (validation) and the web app (dropdowns) share one source of truth for the
 * human-readable labels — the enum *values* themselves stay English identifiers.
 */
export interface EnumOption {
  value: string;
  labelAr: string;
  labelEn: string;
}

export const CUSTOMER_TYPES: EnumOption[] = [
  { value: 'RESIDENTIAL', labelAr: 'سكني', labelEn: 'Residential' },
  { value: 'CI', labelAr: 'تجاري وصناعي', labelEn: 'Commercial & Industrial' },
  { value: 'UTILITY', labelAr: 'مرافق', labelEn: 'Utility' },
  { value: 'GOVERNMENT', labelAr: 'حكومي', labelEn: 'Government' },
];

/** CRM Phase 1 (Step 2): a customer is a business or a person — it decides which unique key is mandatory. */
export const CUSTOMER_ENTITY_KINDS: EnumOption[] = [
  { value: 'COMPANY', labelAr: 'منشأة', labelEn: 'Company' },
  { value: 'INDIVIDUAL', labelAr: 'فرد', labelEn: 'Individual' },
];

export const LEAD_SOURCES: EnumOption[] = [
  { value: 'WEBSITE', labelAr: 'الموقع الإلكتروني', labelEn: 'Website' },
  { value: 'REFERRAL', labelAr: 'إحالة', labelEn: 'Referral' },
  { value: 'CAMPAIGN', labelAr: 'حملة تسويقية', labelEn: 'Campaign' },
  { value: 'DIRECT', labelAr: 'مباشر', labelEn: 'Direct' },
  { value: 'WHATSAPP', labelAr: 'واتساب', labelEn: 'WhatsApp' },
  { value: 'OTHER', labelAr: 'أخرى', labelEn: 'Other' },
];

export const LEAD_STATUSES: EnumOption[] = [
  { value: 'NEW', labelAr: 'جديد', labelEn: 'New' },
  { value: 'QUALIFIED', labelAr: 'مؤهَّل', labelEn: 'Qualified' },
  { value: 'DISQUALIFIED', labelAr: 'غير مؤهَّل', labelEn: 'Disqualified' },
  { value: 'CONVERTED', labelAr: 'محوَّل', labelEn: 'Converted' },
];

// CRM Phase 1 · Step 3 (§4.2 / §9): محتمل ← تأهيل ← عرض سعر ← تفاوض ← رابحة | خاسرة.
// The order here IS the funnel order; the transition rules live in
// opportunity-stages.ts.
export const OPPORTUNITY_STAGES: EnumOption[] = [
  { value: 'PROSPECTING', labelAr: 'محتمل', labelEn: 'Prospecting' },
  { value: 'QUALIFICATION', labelAr: 'تأهيل', labelEn: 'Qualification' },
  { value: 'PROPOSAL', labelAr: 'عرض سعر', labelEn: 'Proposal' },
  { value: 'NEGOTIATION', labelAr: 'تفاوض', labelEn: 'Negotiation' },
  { value: 'WON', labelAr: 'رابحة', labelEn: 'Won' },
  { value: 'LOST', labelAr: 'خاسرة', labelEn: 'Lost' },
];

export const OPPORTUNITY_TYPES: EnumOption[] = [
  { value: 'DIRECT', labelAr: 'مباشرة', labelEn: 'Direct' },
  { value: 'TENDER', labelAr: 'مناقصة', labelEn: 'Tender' },
];

export const ITEM_CATEGORIES: EnumOption[] = [
  { value: 'MODULE', labelAr: 'لوح شمسي', labelEn: 'PV Module' },
  { value: 'INVERTER', labelAr: 'عاكس', labelEn: 'Inverter' },
  { value: 'MOUNTING', labelAr: 'هياكل تثبيت', labelEn: 'Mounting' },
  { value: 'CABLE', labelAr: 'كابلات', labelEn: 'Cable' },
  { value: 'BOS', labelAr: 'مكونات مساعدة', labelEn: 'Balance of System' },
  { value: 'SPARE', labelAr: 'قطع غيار', labelEn: 'Spare Part' },
  { value: 'SERVICE', labelAr: 'خدمة', labelEn: 'Service' },
];

// CRM Phase 1 · Step 4 (§9): مسودة ← بانتظار الاعتماد ← معتمد ← مُرسل ← مقبول | مرفوض
// (رفض العميل) | منتهي الصلاحية | مُستبدَل بنسخة أحدث. The order is the document's.
export const PROPOSAL_STATUSES: EnumOption[] = [
  { value: 'DRAFT', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'PENDING_APPROVAL', labelAr: 'بانتظار الاعتماد', labelEn: 'Pending approval' },
  { value: 'APPROVED', labelAr: 'معتمد', labelEn: 'Approved' },
  { value: 'SENT', labelAr: 'مُرسَل', labelEn: 'Sent' },
  { value: 'ACCEPTED', labelAr: 'مقبول', labelEn: 'Accepted' },
  { value: 'REJECTED', labelAr: 'مرفوض', labelEn: 'Rejected' },
  { value: 'EXPIRED', labelAr: 'منتهي الصلاحية', labelEn: 'Expired' },
  { value: 'SUPERSEDED', labelAr: 'مُستبدَل بنسخة أحدث', labelEn: 'Superseded by a newer revision' },
];

/** Where a proposal line's cost came from (spec 4.3): the last purchase, or a recorded manual change. */
export const COST_SOURCES: EnumOption[] = [
  { value: 'GRN', labelAr: 'آخر استلام مقبول', labelEn: 'Last accepted receipt' },
  { value: 'PO', labelAr: 'آخر أمر شراء معتمد', labelEn: 'Last approved purchase order' },
  { value: 'CATALOGUE', labelAr: 'تكلفة الكتالوج', labelEn: 'Catalogue cost' },
  { value: 'MANUAL', labelAr: 'تعديل يدوي', labelEn: 'Manual change' },
];

export const CONTRACT_TYPES: EnumOption[] = [
  { value: 'EPC', labelAr: 'هندسة وتوريد وتنفيذ', labelEn: 'EPC' },
  { value: 'PPA', labelAr: 'شراء طاقة', labelEn: 'PPA' },
  { value: 'OM', labelAr: 'تشغيل وصيانة', labelEn: 'O&M' },
  { value: 'LEASE', labelAr: 'إيجار', labelEn: 'Lease' },
];

export const INVOICE_TYPES: EnumOption[] = [
  { value: 'MILESTONE', labelAr: 'مرحلية', labelEn: 'Milestone' },
  { value: 'SETTLEMENT', labelAr: 'تسوية', labelEn: 'Settlement' },
  { value: 'SERVICE', labelAr: 'خدمة', labelEn: 'Service' },
  { value: 'CREDIT_NOTE', labelAr: 'إشعار دائن', labelEn: 'Credit note' },
];

export const INVOICE_STATUSES: EnumOption[] = [
  { value: 'DRAFT', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'ISSUED', labelAr: 'مُصدَرة', labelEn: 'Issued' },
  { value: 'CLEARED', labelAr: 'معتمدة (ZATCA)', labelEn: 'Cleared (ZATCA)' },
  { value: 'PAID', labelAr: 'مدفوعة', labelEn: 'Paid' },
  { value: 'CANCELLED', labelAr: 'ملغاة', labelEn: 'Cancelled' },
];

export const CONTRACT_STATUSES: EnumOption[] = [
  { value: 'DRAFT', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'ACTIVE', labelAr: 'نشط', labelEn: 'Active' },
  { value: 'SUSPENDED', labelAr: 'موقوف', labelEn: 'Suspended' },
  { value: 'CLOSED', labelAr: 'مغلق', labelEn: 'Closed' },
  { value: 'CANCELLED', labelAr: 'ملغى', labelEn: 'Cancelled' },
];

export const MILESTONE_TRIGGER_TYPES: EnumOption[] = [
  { value: 'DATE', labelAr: 'تاريخ', labelEn: 'Date' },
  { value: 'PROGRESS', labelAr: 'نسبة إنجاز', labelEn: 'Progress' },
  { value: 'EVENT', labelAr: 'حدث', labelEn: 'Event' },
];

export const MILESTONE_STATUSES: EnumOption[] = [
  { value: 'PENDING', labelAr: 'قيد الانتظار', labelEn: 'Pending' },
  { value: 'VERIFIED', labelAr: 'تم التحقق', labelEn: 'Verified' },
  { value: 'INVOICED', labelAr: 'تمت الفوترة', labelEn: 'Invoiced' },
];

// ─── W2: Deliver & Cost ────────────────────────────────────────────────────

export const PROJECT_STAGES: EnumOption[] = [
  { value: 'PLANNING', labelAr: 'تخطيط', labelEn: 'Planning' },
  { value: 'PROCUREMENT', labelAr: 'مشتريات', labelEn: 'Procurement' },
  { value: 'EXECUTION', labelAr: 'تنفيذ', labelEn: 'Execution' },
  { value: 'COMMISSIONING', labelAr: 'تشغيل تجريبي', labelEn: 'Commissioning' },
  { value: 'CLOSED', labelAr: 'مغلق', labelEn: 'Closed' },
];

/**
 * The project lifecycle, in order. Derived from PROJECT_STAGES so the sequence
 * cannot drift from the labels.
 *
 * This lives in the shared package because BOTH sides need it and they must
 * agree: the web app uses it to offer the next stage, and the API uses it to
 * enforce the move. Previously only the web knew the order, which meant the
 * rule was advisory — anything calling the endpoint directly could jump
 * straight from PLANNING to CLOSED.
 */
export const PROJECT_STAGE_FLOW: string[] = PROJECT_STAGES.map((s) => s.value);

/**
 * Whether `to` is a legal move from `from`: forward exactly one step.
 *
 * Skipping ahead is refused because each stage gates real work (procurement
 * commits cost, commissioning closes it out); jumping past one leaves the
 * project's records claiming something that never happened. Moving backwards
 * is refused too — reversing a stage has accounting consequences that need a
 * deliberate correction, not a dropdown. Widen this if the business asks, but
 * do it here, once, where both sides read it.
 */
export function isValidStageTransition(from: string, to: string): boolean {
  const i = PROJECT_STAGE_FLOW.indexOf(from);
  const j = PROJECT_STAGE_FLOW.indexOf(to);
  return i >= 0 && j >= 0 && j === i + 1;
}

export const VENDOR_TYPES: EnumOption[] = [
  { value: 'SUPPLIER', labelAr: 'مورد', labelEn: 'Supplier' },
  { value: 'SUBCONTRACTOR', labelAr: 'مقاول باطن', labelEn: 'Subcontractor' },
  { value: 'OEM', labelAr: 'مصنّع', labelEn: 'OEM' },
  { value: 'SERVICE', labelAr: 'خدمات', labelEn: 'Service' },
];

export const PO_STATUSES: EnumOption[] = [
  { value: 'DRAFT', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'APPROVED', labelAr: 'معتمد', labelEn: 'Approved' },
  { value: 'PARTIALLY_RECEIVED', labelAr: 'مستلم جزئياً', labelEn: 'Partially received' },
  { value: 'RECEIVED', labelAr: 'مستلم', labelEn: 'Received' },
  { value: 'CLOSED', labelAr: 'مغلق', labelEn: 'Closed' },
  { value: 'CANCELLED', labelAr: 'ملغى', labelEn: 'Cancelled' },
];

export const SERIAL_STATES: EnumOption[] = [
  { value: 'IN_STOCK', labelAr: 'في المخزون', labelEn: 'In stock' },
  { value: 'INSTALLED', labelAr: 'مركَّب', labelEn: 'Installed' },
  { value: 'FAULTY', labelAr: 'معطّل', labelEn: 'Faulty' },
  { value: 'RETURNED', labelAr: 'مرتجع', labelEn: 'Returned' },
  { value: 'SCRAPPED', labelAr: 'مُتلَف', labelEn: 'Scrapped' },
];

export const COST_TYPES: EnumOption[] = [
  { value: 'MATERIAL', labelAr: 'مواد', labelEn: 'Material' },
  { value: 'LABOUR', labelAr: 'عمالة', labelEn: 'Labour' },
  { value: 'SUBCONTRACT', labelAr: 'مقاولة باطن', labelEn: 'Subcontract' },
  { value: 'EQUIPMENT', labelAr: 'معدات', labelEn: 'Equipment' },
  { value: 'OVERHEAD', labelAr: 'نفقات عامة', labelEn: 'Overhead' },
];

export const BILL_STATUSES: EnumOption[] = [
  { value: 'DRAFT', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'POSTED', labelAr: 'مرحَّلة', labelEn: 'Posted' },
  { value: 'PAID', labelAr: 'مدفوعة', labelEn: 'Paid' },
];

export const CHANGE_ORDER_STATUSES: EnumOption[] = [
  { value: 'DRAFT', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'APPROVED', labelAr: 'معتمد', labelEn: 'Approved' },
  { value: 'REJECTED', labelAr: 'مرفوض', labelEn: 'Rejected' },
];

export const SUBCONTRACT_STATUSES: EnumOption[] = [
  { value: 'DRAFT', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'ACTIVE', labelAr: 'نشطة', labelEn: 'Active' },
  { value: 'COMPLETED', labelAr: 'مكتملة', labelEn: 'Completed' },
  { value: 'TERMINATED', labelAr: 'منهاة', labelEn: 'Terminated' },
];

export const CLAIM_STATUSES: EnumOption[] = [
  { value: 'SUBMITTED', labelAr: 'مقدَّم', labelEn: 'Submitted' },
  { value: 'APPROVED', labelAr: 'معتمد', labelEn: 'Approved' },
  { value: 'PAID', labelAr: 'مدفوع', labelEn: 'Paid' },
  { value: 'REJECTED', labelAr: 'مرفوض', labelEn: 'Rejected' },
];

export const LOCATION_TYPES: EnumOption[] = [
  { value: 'WAREHOUSE', labelAr: 'مستودع', labelEn: 'Warehouse' },
  { value: 'LAYDOWN_YARD', labelAr: 'ساحة تجميع', labelEn: 'Laydown yard' },
  { value: 'SITE', labelAr: 'موقع تنفيذ', labelEn: 'Job site' },
  { value: 'VAN', labelAr: 'مركبة فني', labelEn: 'Technician van' },
];

// ─── W4: Operate ───────────────────────────────────────────────────────────

export const ASSET_TYPES: EnumOption[] = [
  { value: 'PLANT', labelAr: 'محطة', labelEn: 'Plant' },
  { value: 'BLOCK', labelAr: 'قطاع', labelEn: 'Block' },
  { value: 'ARRAY', labelAr: 'مصفوفة', labelEn: 'Array' },
  { value: 'STRING', labelAr: 'سلسلة', labelEn: 'String' },
  { value: 'MODULE', labelAr: 'لوح شمسي', labelEn: 'PV Module' },
  { value: 'INVERTER', labelAr: 'عاكس', labelEn: 'Inverter' },
  { value: 'TRANSFORMER', labelAr: 'محوّل', labelEn: 'Transformer' },
  { value: 'TRACKER', labelAr: 'متتبّع', labelEn: 'Tracker' },
  { value: 'METER', labelAr: 'عداد', labelEn: 'Meter' },
  { value: 'COMBINER', labelAr: 'مجمّع', labelEn: 'Combiner' },
  { value: 'EQUIPMENT', labelAr: 'معدّة', labelEn: 'Equipment' },
];

export const ASSET_STATUSES: EnumOption[] = [
  { value: 'OPERATING', labelAr: 'عامل', labelEn: 'Operating' },
  { value: 'FAULTY', labelAr: 'معطّل', labelEn: 'Faulty' },
  { value: 'UNDER_MAINTENANCE', labelAr: 'تحت الصيانة', labelEn: 'Under maintenance' },
  { value: 'RETIRED', labelAr: 'خارج الخدمة', labelEn: 'Retired' },
];

export const WO_TYPES: EnumOption[] = [
  { value: 'CORRECTIVE', labelAr: 'تصحيحي', labelEn: 'Corrective' },
  { value: 'PREVENTIVE', labelAr: 'وقائي', labelEn: 'Preventive' },
  { value: 'CLEANING', labelAr: 'تنظيف', labelEn: 'Cleaning' },
  { value: 'INSPECTION', labelAr: 'فحص', labelEn: 'Inspection' },
  { value: 'COMMISSIONING', labelAr: 'تشغيل تجريبي', labelEn: 'Commissioning' },
];

export const WO_ORIGINS: EnumOption[] = [
  { value: 'MANUAL', labelAr: 'يدوي', labelEn: 'Manual' },
  { value: 'PLAN', labelAr: 'خطة صيانة', labelEn: 'Maintenance plan' },
  { value: 'ALERT', labelAr: 'إنذار', labelEn: 'Alert' },
  { value: 'TICKET', labelAr: 'تذكرة', labelEn: 'Ticket' },
];

export const WO_PRIORITIES: EnumOption[] = [
  { value: 'LOW', labelAr: 'منخفضة', labelEn: 'Low' },
  { value: 'MEDIUM', labelAr: 'متوسطة', labelEn: 'Medium' },
  { value: 'HIGH', labelAr: 'عالية', labelEn: 'High' },
  { value: 'CRITICAL', labelAr: 'حرجة', labelEn: 'Critical' },
];

export const WARRANTY_CLAIM_STATUSES: EnumOption[] = [
  { value: 'DRAFT', labelAr: 'مسودة', labelEn: 'Draft' },
  { value: 'SUBMITTED', labelAr: 'مقدَّمة للمصنّع', labelEn: 'Submitted' },
  { value: 'APPROVED', labelAr: 'معتمدة', labelEn: 'Approved' },
  { value: 'REJECTED', labelAr: 'مرفوضة', labelEn: 'Rejected' },
  { value: 'REPLACED', labelAr: 'تم الاستبدال', labelEn: 'Replaced' },
];

export const PAYMENT_METHODS: EnumOption[] = [
  { value: 'BANK_TRANSFER', labelAr: 'تحويل بنكي', labelEn: 'Bank transfer' },
  { value: 'CHEQUE', labelAr: 'شيك', labelEn: 'Cheque' },
  { value: 'CASH', labelAr: 'نقداً', labelEn: 'Cash' },
];

export const BILLING_CYCLES: EnumOption[] = [
  { value: 'MONTHLY', labelAr: 'شهري', labelEn: 'Monthly' },
  { value: 'QUARTERLY', labelAr: 'ربع سنوي', labelEn: 'Quarterly' },
];

export const PPA_STATUSES: EnumOption[] = [
  { value: 'ACTIVE', labelAr: 'نشطة', labelEn: 'Active' },
  { value: 'SUSPENDED', labelAr: 'موقوفة', labelEn: 'Suspended' },
  { value: 'ENDED', labelAr: 'منتهية', labelEn: 'Ended' },
];

export const ALERT_TYPES: EnumOption[] = [
  { value: 'UNDERPERFORMANCE', labelAr: 'أداء منخفض', labelEn: 'Underperformance' },
  { value: 'OFFLINE', labelAr: 'خارج الخدمة', labelEn: 'Offline' },
  { value: 'COMM_LOSS', labelAr: 'فقد اتصال', labelEn: 'Comm loss' },
  { value: 'OVERTEMP', labelAr: 'حرارة زائدة', labelEn: 'Over-temperature' },
];

export const ALERT_SEVERITIES: EnumOption[] = [
  { value: 'INFO', labelAr: 'معلومة', labelEn: 'Info' },
  { value: 'WARNING', labelAr: 'تحذير', labelEn: 'Warning' },
  { value: 'CRITICAL', labelAr: 'حرج', labelEn: 'Critical' },
];

export const ALERT_STATUSES: EnumOption[] = [
  { value: 'OPEN', labelAr: 'مفتوح', labelEn: 'Open' },
  { value: 'ACKNOWLEDGED', labelAr: 'مؤكَّد', labelEn: 'Acknowledged' },
  { value: 'WORK_ORDERED', labelAr: 'صدر أمر عمل', labelEn: 'Work ordered' },
  { value: 'RESOLVED', labelAr: 'محلول', labelEn: 'Resolved' },
];

export const WO_STATUSES: EnumOption[] = [
  { value: 'OPEN', labelAr: 'مفتوح', labelEn: 'Open' },
  { value: 'ASSIGNED', labelAr: 'مُسنَد', labelEn: 'Assigned' },
  { value: 'IN_PROGRESS', labelAr: 'قيد التنفيذ', labelEn: 'In progress' },
  { value: 'COMPLETED', labelAr: 'منجز', labelEn: 'Completed' },
  { value: 'CLOSED', labelAr: 'مغلق', labelEn: 'Closed' },
  { value: 'CANCELLED', labelAr: 'ملغى', labelEn: 'Cancelled' },
];
