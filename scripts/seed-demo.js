/**
 * Demo-data seeder for stakeholder presentations.
 * Runs through the LIVE API (real numbering, journals, ZATCA chain, stock,
 * auto-assets) — safe to rerun: creations use DEMO- names and tolerate 400s.
 *   node scripts/seed-demo.js
 */
const API = process.env.API_URL ?? 'http://localhost:4000/api';
let TOKEN = '';

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json?.message ?? text}`);
  return json;
}
/** Multipart upload (attachments): Node's own FormData and Blob, no package. */
async function upload(path, fileName, bytes, type) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), fileName);
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${json?.message ?? text}`);
  return json;
}
/** A one-page placeholder PDF standing for the customer's signed approval (demo only). */
const DEMO_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * Sign in. The login route allows 5 attempts a minute per address; a run started right
 * after another one (three logins each) can meet the limiter, so a 429 is waited out once.
 */
async function login(email, password) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt === 0) {
      console.log('… login limiter engaged (5 a minute) — waiting 61 s once');
      await new Promise((r) => setTimeout(r, 61_000));
      continue;
    }
    if (!res.ok) throw new Error(`login ${email} → ${res.status}: ${json?.message}`);
    return json.accessToken;
  }
}
/** Run `fn` with another user's token (the executive signs what the salesperson raises), then restore. */
const tokens = new Map(); // one login per user: the login route is rate-limited
async function asUser(email, password, fn) {
  const saved = TOKEN;
  try {
    if (!tokens.has(email)) tokens.set(email, await login(email, password));
    TOKEN = tokens.get(email);
    return await fn();
  } finally {
    TOKEN = saved;
  }
}
const step = async (name, fn) => {
  try {
    const r = await fn();
    console.log(`✓ ${name}`);
    return r;
  } catch (e) {
    console.log(`~ ${name} — skipped (${String(e.message).slice(0, 90)})`);
    return null;
  }
};

// The seeded signers. P1-13: seed.ts writes the five rules of PROPOSED_APPROVAL_RULES
// (packages/shared/src/presets.ts), every one from 0 SAR, so every order and claim the demo
// raises waits in an approvals inbox: order → executive; claim → pm, then executive.
const CEO = { email: 'ceo@npi.sa', password: 'Ceo@12345', titleAr: 'المدير العام' };
const PM = { email: 'pm@npi.sa', password: 'Pm@123456', titleAr: 'مدير عام المشاريع' };

/**
 * Signs the open chain of one document, step by step, each step by the seeded user holding
 * that step's role (`chain`, in signing order). A signer whose inbox does not hold the
 * document is passed over without a line: on a rerun the chain may already be past them.
 * Returns false when a signature was refused (the step() line says why).
 */
async function signChain(documentType, documentId, chain, label) {
  for (const who of chain) {
    let row;
    try {
      row = await asUser(who.email, who.password, async () =>
        (await call('GET', '/approvals/inbox')).find((r) => r.documentType === documentType && r.documentId === documentId),
      );
    } catch (e) {
      console.log(`~ اعتماد ${who.titleAr}: ${label} — skipped (${String(e.message).slice(0, 90)})`);
      return false;
    }
    if (!row) continue;
    const signed = await step(`اعتماد ${who.titleAr}: ${label}`, () =>
      asUser(who.email, who.password, () =>
        call('POST', `/approvals/${row.id}/decide`, { decision: 'APPROVE', note: `اعتماد ${label}` }),
      ),
    );
    if (!signed) return false;
  }
  return true;
}

(async () => {
  TOKEN = await login('admin@npi.sa', 'Admin@123');

  // ── 1. Customers ────────────────────────────────────────────────────────
  const customerDefs = [
    { nameAr: 'مستشفى الشفاء التخصصي', nameEn: 'Al-Shifa Specialist Hospital', customerType: 'CI', vatNumber: '310111111100003', phone: '0138765432' },
    { nameAr: 'مصنع أسمنت الشرقية', nameEn: 'Eastern Cement Factory', customerType: 'CI', vatNumber: '310222222200003', phone: '0503216549' },
    { nameAr: 'بلدية محافظة الأحساء', nameEn: 'Al-Ahsa Municipality', customerType: 'GOVERNMENT', phone: '0135801000' },
    { nameAr: 'مجمع الواحة التجاري', nameEn: 'Al-Waha Mall', customerType: 'CI', vatNumber: '310333333300003' },
  ];
  const existing = await call('GET', '/customers');
  const customers = {};
  for (const c of customerDefs) {
    const found = existing.find((x) => x.nameAr === c.nameAr);
    customers[c.nameAr] = found ?? (await step(`عميل: ${c.nameAr}`, () => call('POST', '/customers', c)));
  }

  // ── 2. Leads across statuses ────────────────────────────────────────────
  const leadsNow = await call('GET', '/leads');
  const leadDefs = [
    { contactName: 'م. خالد الدوسري', companyName: 'مزارع الدوسري', source: 'WHATSAPP', estimatedKwp: 250, phone: '0551112223' },
    { contactName: 'أ. نورة القحطاني', companyName: 'مدارس الرواد الأهلية', source: 'WEBSITE', estimatedKwp: 400 },
    { contactName: 'م. فهد العتيق', companyName: 'محطة وقود العتيق', source: 'REFERRAL', estimatedKwp: 120 },
    { contactName: 'د. سارة المطيري', companyName: 'مجمع عيادات النخبة', source: 'CAMPAIGN', estimatedKwp: 90 },
  ];
  const leads = [];
  for (const l of leadDefs) {
    const found = leadsNow.find?.((x) => x.contactName === l.contactName) ?? (Array.isArray(leadsNow) ? undefined : leadsNow.rows?.find((x) => x.contactName === l.contactName));
    leads.push(found ?? (await step(`عميل محتمل: ${l.contactName}`, () => call('POST', '/leads', l))));
  }
  if (leads[0] && leads[0].status === 'NEGOTIATING')
    await step('قبول عميل محتمل → فرصة', () => call('POST', `/leads/${leads[0].id}/status`, { status: 'ACCEPTED' }));

  // ── 3. Opportunities + proposals ────────────────────────────────────────
  const items = await call('GET', '/items');
  const mod = items.find((i) => i.sku === 'MOD-550');
  const inv = items.find((i) => i.sku === 'INV-50K');
  const rail = items.find((i) => i.sku === 'MNT-RAIL');
  const schemes = await call('GET', '/reference/pricing-schemes');

  // CRM Step 4: a proposal is not accepted straight from a draft any more. It is raised for
  // approval, signed by the executive (ceo@npi.sa, through the approvals inbox), sent to the
  // customer, and only then accepted. `upTo` says how far the demo takes it:
  //   'accept' - accepted (a contract can follow) · 'sent' - with the customer ·
  //   'pending' - waiting in the executive's inbox · 'draft' - left as a draft.
  // The BOM is priced in SELLING prices now (the old demo prices were cost bases): the
  // server fetches each line's cost itself (last purchase, else the catalogue).
  const margin = 1 + Number(schemes[0]?.marginPct ?? 0) / 100;
  const sell = (base) => Math.round(base * margin * 100) / 100;

  async function takeProposalTo(upTo, name, p, rev) {
    if (!rev || upTo === 'draft') return;
    const raised = await step(`رفع العرض للاعتماد: ${name}`, () => call('POST', `/proposals/${p.id}/submit`, {}));
    if (!raised || upTo === 'pending') return;
    const signed = await step(`اعتماد الرئيس التنفيذي: ${name}`, () =>
      asUser(CEO.email, CEO.password, async () => {
        const inbox = await call('GET', '/approvals/inbox');
        const row = inbox.find((r) => r.documentType === 'PROPOSAL' && r.documentId === p.id);
        if (!row) throw new Error('not in the executive inbox');
        return call('POST', `/approvals/${row.id}/decide`, { decision: 'APPROVE', note: 'اعتماد العرض' });
      }),
    );
    if (!signed) return;
    const sent = await step(`إرسال العرض للعميل: ${name}`, () => call('POST', `/proposals/${p.id}/send`, {}));
    if (!sent || upTo === 'sent') return;
    // P3-8: the customer's approval is filed on the proposal before it is accepted.
    const filed = await step(`إرفاق موافقة العميل: ${name}`, () =>
      upload(`/attachments/PROPOSAL/${p.id}`, 'موافقة-العميل.pdf', DEMO_PDF, 'application/pdf'),
    );
    if (!filed) return;
    await step(`قبول العميل: ${name}`, () => call('POST', `/proposals/${p.id}/revisions/${rev.id}/accept`, {}));
  }

  async function makeOppWithProposal(custKey, name, kwp, qtyMod, upTo) {
    const cust = customers[custKey];
    if (!cust) return null;
    const opps = await call('GET', '/opportunities');
    let opp = opps.find((o) => o.name === name);
    if (!opp)
      opp = await step(`فرصة: ${name}`, () =>
        call('POST', '/opportunities', { name, customerId: cust.id, estimatedKwp: kwp, estimatedValue: qtyMod * 800 }),
      );
    if (!opp) return null;
    if ((opp._count?.proposals ?? 0) > 0) return opp;
    const p = await step(`عرض للفرصة: ${name}`, () => call('POST', '/proposals', { opportunityId: opp.id }));
    if (!p) return opp;
    const rev = await step(`مراجعة + BOM: ${name}`, () =>
      call('POST', `/proposals/${p.id}/revisions`, {
        pricingSchemeId: schemes[0]?.id,
        bomLines: [
          { itemId: mod.id, qty: qtyMod, unitPrice: sell(800) },
          { itemId: inv.id, qty: Math.ceil(qtyMod / 90), unitPrice: sell(22000) },
          { itemId: rail.id, qty: qtyMod * 2, unitPrice: sell(45) },
        ],
        designVersion: { sourceTool: 'PVsyst', capacityKwp: kwp, expectedAnnualKwh: kwp * 1650 },
      }),
    );
    await takeProposalTo(upTo, name, p, rev);
    return { opp, proposal: p, revision: rev };
  }

  const hosp = await makeOppWithProposal('مستشفى الشفاء التخصصي', 'نظام شمسي لمواقف المستشفى 500kWp', 500, 910, 'accept');
  await makeOppWithProposal('مصنع أسمنت الشرقية', 'محطة أرضية للمصنع 2MWp', 2000, 3640, 'sent');
  await makeOppWithProposal('مجمع الواحة التجاري', 'أسطح المجمع التجاري 300kWp', 300, 546, 'pending');

  // ── 3b. Package 3: project work items, a standard budget, and one estimated
  // budget (lump sum) waiting on the general manager. DEMO data only — the
  // company's own work-item list and its 990 / 1230 templates replace these.
  const workItemDefs = [
    { code: 'DEMO-WI-01', nameAr: 'ألواح شمسية', nameEn: 'Solar panels', kind: 'MATERIAL', uom: 'panel', itemId: mod?.id, sortOrder: 1 },
    { code: 'DEMO-WI-02', nameAr: 'محولات (عواكس)', nameEn: 'Inverters', kind: 'MATERIAL', uom: 'unit', itemId: inv?.id, sortOrder: 2 },
    { code: 'DEMO-WI-03', nameAr: 'هياكل التثبيت', nameEn: 'Mounting structures', kind: 'MATERIAL', uom: 'm', itemId: rail?.id, sortOrder: 3 },
    { code: 'DEMO-WI-04', nameAr: 'دق وتركيب الهياكل', nameEn: 'Piling and structure installation', kind: 'LABOUR', uom: 'kW', defaultUnitCost: 40, sortOrder: 4 },
    { code: 'DEMO-WI-05', nameAr: 'تنفيذ أعمال الكهرباء', nameEn: 'Electrical works', kind: 'LABOUR', uom: 'kW', defaultUnitCost: 55, sortOrder: 5 },
    { code: 'DEMO-WI-06', nameAr: 'إيجار رافعة ومعدات', nameEn: 'Crane and equipment rental', kind: 'EQUIPMENT', uom: 'day', defaultUnitCost: 1800, sortOrder: 6 },
    { code: 'DEMO-WI-07', nameAr: 'نقل وإقامة الفريق', nameEn: 'Transport and crew lodging', kind: 'EXPENSE', uom: 'lot', defaultUnitCost: 25000, sortOrder: 7 },
  ];
  const wiNow = await call('GET', '/work-items?all=1').catch(() => []);
  const wi = {};
  for (const d of workItemDefs) {
    const found = wiNow.find((w) => w.code === d.code);
    const body = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
    wi[d.code] = found ?? (await step(`بند مشروع: ${d.nameAr}`, () => call('POST', '/work-items', body)));
  }
  const tplNow = await call('GET', '/budget-templates?all=1').catch(() => []);
  if (!tplNow.find((x) => x.code === 'DEMO-T-300') && Object.values(wi).every(Boolean)) {
    await step('قالب موازنة تجريبي 300kWp', () =>
      call('POST', '/budget-templates', {
        code: 'DEMO-T-300',
        nameAr: 'قالب تجريبي — 546 لوحاً (300kWp)',
        nameEn: 'Demo template — 546 panels (300kWp)',
        panelCount: 546,
        capacityKwp: 300,
        lines: [
          { workItemId: wi['DEMO-WI-01'].id, qty: 546 },
          { workItemId: wi['DEMO-WI-02'].id, qty: 6 },
          { workItemId: wi['DEMO-WI-03'].id, qty: 1092 },
          { workItemId: wi['DEMO-WI-04'].id, qty: 300 },
          { workItemId: wi['DEMO-WI-05'].id, qty: 300 },
          { workItemId: wi['DEMO-WI-06'].id, qty: 4 },
          { workItemId: wi['DEMO-WI-07'].id, qty: 1 },
        ],
      }),
    );
  }
  // One estimated budget (lump sum) for a pump-station farm, raised to the general manager.
  const farmCust = customers['مجمع الواحة التجاري'];
  const farmName = 'مزرعة تجريبية — تشغيل مضخات الآبار 300kWp';
  const oppsNow = await call('GET', '/opportunities');
  if (farmCust && Object.values(wi).every(Boolean) && !oppsNow.find((o) => o.name === farmName)) {
    const opp = await step(`فرصة: ${farmName}`, () =>
      call('POST', '/opportunities', { name: farmName, customerId: farmCust.id, estimatedKwp: 300 }),
    );
    const p = opp && (await step(`موازنة تقديرية: ${farmName}`, () => call('POST', '/proposals', { opportunityId: opp.id })));
    const rev =
      p &&
      (await step(`سطور الموازنة (سعر مقطوع): ${farmName}`, () =>
        call('POST', `/proposals/${p.id}/revisions`, {
          pricingMode: 'LUMP_SUM',
          sellingTotal: 690000,
          contingencyPct: 3,
          riskNotes: 'تذبذب سعر الألواح؛ بُعد الموقع عن المستودع.',
          bomLines: [
            { workItemId: wi['DEMO-WI-01'].id, qty: 546 },
            { workItemId: wi['DEMO-WI-02'].id, qty: 6 },
            { workItemId: wi['DEMO-WI-03'].id, qty: 1092 },
            { workItemId: wi['DEMO-WI-04'].id, qty: 300 },
            { workItemId: wi['DEMO-WI-05'].id, qty: 300 },
            { workItemId: wi['DEMO-WI-06'].id, qty: 4 },
            { workItemId: wi['DEMO-WI-07'].id, qty: 1 },
          ],
          designVersion: { sourceTool: 'manual', capacityKwp: 300, expectedAnnualKwh: 300 * 1650 },
        }),
      ));
    if (rev) await takeProposalTo('pending', farmName, p, rev);
  }

  // ── 4. Contract #2 (hospital) → activate → milestone → invoice → payment
  let contract2 = (await call('GET', '/contracts')).find((c) => c.customer?.nameAr === 'مستشفى الشفاء التخصصي');
  if (!contract2 && hosp?.revision) {
    contract2 = await step('عقد المستشفى + مراحل', () =>
      call('POST', '/contracts', {
        proposalRevisionId: hosp.revision.id,
        contractType: 'EPC',
        retentionPct: 5,
        advancePct: 10,
        milestones: [
          { sequence: 1, descriptionAr: 'دفعة التعاقد والتصاميم', descriptionEn: 'Mobilization & design', amount: 250000, triggerType: 'PROGRESS' },
          { sequence: 2, descriptionAr: 'توريد المعدات للموقع', descriptionEn: 'Equipment delivery', amount: 500000, triggerType: 'PROGRESS' },
          { sequence: 3, descriptionAr: 'التركيب والتشغيل التجريبي', descriptionEn: 'Installation & commissioning', amount: 350000, triggerType: 'PROGRESS' },
        ],
      }),
    );
    if (contract2) await step('تفعيل عقد المستشفى', () => call('POST', `/contracts/${contract2.id}/activate`, {}));
  }
  if (contract2) {
    const full = await call('GET', `/contracts/${contract2.id}`);
    const m1 = full.milestones?.find((m) => m.sequence === 1);
    if (m1 && m1.status === 'PENDING')
      await step('اعتماد المرحلة 1', () => call('POST', `/contracts/${contract2.id}/milestones/${m1.id}/verify`, {}));
    const m1b = (await call('GET', `/contracts/${contract2.id}`)).milestones.find((m) => m.sequence === 1);
    if (m1b?.status === 'VERIFIED') {
      const invd = await step('فاتورة المرحلة 1', () =>
        call('POST', `/finance/contracts/${contract2.id}/milestones/${m1b.id}/invoice`, {}),
      );
      if (invd) {
        await step('إصدار الفاتورة (ZATCA)', () => call('POST', `/finance/invoices/${invd.id}/issue`, {}));
        await step('دفعة جزئية 150,000', () =>
          call('POST', `/finance/invoices/${invd.id}/payments`, { amount: 150000, method: 'BANK_TRANSFER', reference: 'TRF-2026-114' }),
        );
      }
    }

    // ── 5. Project #2 → PO → approve → send → receive → inspect → accept → bill → match
    //       → approve → schedule → install serials
    let prj2 = (await call('GET', '/projects')).find((p) => p.contractId === contract2.id);
    if (!prj2) prj2 = await step('مشروع المستشفى', () => call('POST', '/projects', { contractId: contract2.id }));
    if (prj2) {
      const vendors = await call('GET', '/procurement/vendors');
      // The M4 workflow engine split what used to be two calls into the real procurement
      // flow (spec §7). Purchase order: DRAFT → approve → APPROVED → send → SENT; `receive`
      // refuses anything but SENT / PARTIALLY_RECEIVED. Goods receipt: a delivery note
      // (DRAFT) → inspect → INSPECTED → accept → ACCEPTED — only acceptance moves stock,
      // creates the serial units and books the project actuals, and only an ACCEPTED
      // receipt can be billed. Vendor bill: DRAFT → match → MATCHED → approve → APPROVED
      // (the journal Dr WIP + Dr VAT input / Cr AP is posted here) → schedule → SCHEDULED.
      // Signatures (P1-13): the admin's approve raises the order for approval and the seeded
      // PURCHASE_ORDER rule (from 0 SAR, executive) parks it in PENDING_APPROVAL until
      // ceo@npi.sa signs it in the approvals inbox; the final signature applies it (APPROVED).
      // Bill approve and schedule need PAYMENT_WRITE, which admin@npi.sa holds (every key) —
      // with the company's roles alone the accountant (accountant@npi.sa) does those two.
      // Rerun-safe the same way the rest of the script is: the hospital's existing order
      // is picked up wherever an earlier run left it (each stage checks the status first)
      // instead of raising a second order, so the DEMO-MOD serials are never offered twice.
      const poList = await call('GET', '/procurement/purchase-orders');
      let po = poList.find((p) => p.projectId === prj2.id && p.vendorId === vendors[0].id && p.status !== 'CANCELLED');
      if (!po)
        po = await step('أمر شراء 60 لوح', () =>
          call('POST', '/procurement/purchase-orders', {
            vendorId: vendors[0].id,
            projectId: prj2.id,
            lines: [
              { itemId: mod.id, qty: 60, unitPrice: 780 },
              { itemId: rail.id, qty: 120, unitPrice: 42 },
            ],
          }),
        );
      if (po) {
        const poDetail = () => call('GET', `/procurement/purchase-orders/${po.id}`);
        let poFull = await poDetail();
        if (poFull.status === 'DRAFT') {
          await step('رفع أمر الشراء للاعتماد', () => call('POST', `/procurement/purchase-orders/${po.id}/approve`, {}));
          poFull = await poDetail();
        }
        if (poFull.status === 'PENDING_APPROVAL') {
          await signChain('PURCHASE_ORDER', po.id, [CEO], 'أمر الشراء');
          poFull = await poDetail();
        }
        if (poFull.status === 'APPROVED') {
          await step('إرسال أمر الشراء للمورد', () => call('POST', `/procurement/purchase-orders/${po.id}/send`, {}));
          poFull = await poDetail();
        }

        // The latest receipt on the order (the detail lists them newest first).
        let grn = poFull.goodsReceipts?.[0] ?? null;
        if (!grn && poFull.status === 'SENT') {
          const modLine = poFull.lines.find((l) => l.item.sku === 'MOD-550');
          const railLine = poFull.lines.find((l) => l.item.sku === 'MNT-RAIL');
          const serials = Array.from({ length: 20 }, (_, i) => `DEMO-MOD-${String(i + 1).padStart(3, '0')}`);
          grn = await step('استلام جزئي (20 لوح + قضبان) — إذن تسليم', () =>
            call('POST', `/procurement/purchase-orders/${po.id}/receive`, {
              lines: [
                { poLineId: modLine.id, qty: 20, serials },
                { poLineId: railLine.id, qty: 120 },
              ],
              notes: 'التسليم الأول: 20 لوحاً وكل قضبان التثبيت',
            }),
          );
        }
        // inspect / accept / match / approve / schedule take a WorkflowActionDto: `action`
        // is required by validation (the service reads only `comment`).
        if (grn?.status === 'DRAFT')
          grn = (await step('فحص الاستلام', () =>
            call('POST', `/procurement/receipts/${grn.id}/inspect`, { action: 'INSPECT', comment: 'الكميات والأرقام التسلسلية مطابقة لإذن التسليم' }),
          )) ?? grn;
        if (grn?.status === 'INSPECTED')
          grn = (await step('قبول الاستلام (دخول المخزون وتسجيل الأرقام التسلسلية)', () =>
            call('POST', `/procurement/receipts/${grn.id}/accept`, { action: 'ACCEPT' }),
          )) ?? grn;

        if (grn?.status === 'ACCEPTED') {
          poFull = await poDetail();
          let bill = poFull.vendorBills?.find((b) => b.goodsReceiptId === grn.id) ?? null;
          if (!bill)
            bill = await step('تسجيل فاتورة المورد', () =>
              call('POST', '/procurement/bills', { goodsReceiptId: grn.id, vendorRef: 'VINV-2026-0458' }),
            );
          if (bill?.status === 'DRAFT')
            bill = (await step('المطابقة الثلاثية للفاتورة', () =>
              call('POST', `/procurement/bills/${bill.id}/match`, { action: 'MATCH' }),
            )) ?? bill;
          if (bill?.status === 'MATCHED')
            bill = (await step('اعتماد الفاتورة (ترحيل القيد)', () =>
              call('POST', `/procurement/bills/${bill.id}/approve`, { action: 'APPROVE', comment: 'اعتماد فاتورة التسليم الأول' }),
            )) ?? bill;
          if (bill?.status === 'APPROVED')
            await step('جدولة الفاتورة للدفع', () => call('POST', `/procurement/bills/${bill.id}/schedule`, { action: 'SCHEDULE' }));
        }

        // Serial units exist only once the receipt is ACCEPTED (see above).
        const units = await call('GET', '/procurement/serial-units?state=IN_STOCK&search=DEMO-MOD-');
        const demoUnits = units.filter((u) => u.serialNo.startsWith('DEMO-MOD-')).slice(0, 8);
        for (const u of demoUnits) await step(`تركيب ${u.serialNo}`, () => call('POST', `/procurement/serial-units/${u.id}/install`, {}));
      }

      // Subcontract + claim. The admin's approve raises the claim and the seeded
      // PROGRESS_CLAIM rule (from 0 SAR) has pm@npi.sa sign it, then ceo@npi.sa; the last
      // signature posts the accounting (APPROVED). Rerun-safe like the order above: the
      // hospital's subcontract and its first claim are picked up wherever a run left them.
      const SUB_SCOPE_AR = 'الأعمال المدنية وقواعد الهياكل';
      let sub = (await call('GET', '/procurement/subcontracts')).find(
        (a) => a.project?.id === prj2.id && a.scopeAr === SUB_SCOPE_AR,
      );
      if (!sub)
        sub = await step('عقد باطن أعمال مدنية', () =>
          call('POST', '/procurement/subcontracts', {
            vendorId: vendors[0].id, projectId: prj2.id,
            scopeAr: SUB_SCOPE_AR, scopeEn: 'Civil works & foundations',
            amount: 180000, retentionPct: 10,
          }),
        );
      if (sub) {
        let claim = sub.claims?.find((c) => c.sequence === 1) ?? null;
        if (!claim) claim = await step('مستخلص أول 60,000', () => call('POST', `/procurement/subcontracts/${sub.id}/claims`, { claimedAmount: 60000 }));
        if (claim?.status === 'SUBMITTED') {
          const open = (await call('GET', '/approvals/history?documentType=PROGRESS_CLAIM&status=PENDING')).rows.find(
            (r) => r.documentId === claim.id,
          );
          const raised = open ?? (await step('رفع المستخلص للاعتماد', () => call('POST', `/procurement/claims/${claim.id}/approve`, {})));
          if (raised) await signChain('PROGRESS_CLAIM', claim.id, [PM, CEO], 'المستخلص الأول');
        }
      }

      // Steps 6 (telemetry simulation) and 7 (PPA terms and settlement) went with the two hidden sections (owner decision 2026-10-12); their routes are no longer registered.
    }
  }

  // ── 8. Operations variety: manual WOs + plan + RMA ────────────────────
  const assets = await call('GET', '/fsm/assets');
  const anyAsset = assets.find((a) => a.assetType !== 'PLANT') ?? assets[0];
  await step('أمر عمل تصحيحي مفتوح', () =>
    call('POST', '/fsm/work-orders', { titleAr: 'تنظيف الألواح بعد موجة غبار', titleEn: 'Post-duststorm panel cleaning', woType: 'CORRECTIVE', priority: 'HIGH', assetId: anyAsset?.id }),
  );
  const wo2 = await step('أمر عمل وقائي قيد التنفيذ', () =>
    call('POST', '/fsm/work-orders', { titleAr: 'فحص نصف سنوي للعواكس', titleEn: 'Semi-annual inverter check', woType: 'PREVENTIVE', priority: 'MEDIUM', assetId: anyAsset?.id }),
  );
  if (wo2) {
    await step('بدء أمر العمل', () => call('POST', `/fsm/work-orders/${wo2.id}/start`, {}));
    await step('تسجيل 3 ساعات عمالة', () => call('POST', `/fsm/work-orders/${wo2.id}/time`, { hours: 3, hourlyRate: 90 }));
  }
  const plans = await call('GET', '/fsm/plans');
  if (!plans.find((p) => p.nameAr.includes('ربع سنوية')))
    await step('خطة صيانة ربع سنوية', () =>
      call('POST', '/fsm/plans', {
        nameAr: 'صيانة ربع سنوية للمحطة', nameEn: 'Quarterly plant maintenance', intervalDays: 90,
        checklist: [
          { labelAr: 'قياس مقاومة العزل', labelEn: 'قياس مقاومة العزل', mandatory: true },
          { labelAr: 'تنظيف مرشحات العاكس', labelEn: 'تنظيف مرشحات العاكس', mandatory: true },
          { labelAr: 'فحص إحكام التوصيلات', labelEn: 'فحص إحكام التوصيلات' },
        ],
      }),
    );
  const installed = (await call('GET', '/procurement/serial-units?state=INSTALLED')).filter((u) => u.serialNo.startsWith('DEMO-'));
  if (installed[0]) {
    const claim = await step(`بلاغ ضمان على ${installed[0].serialNo}`, () =>
      call('POST', '/fsm/warranty-claims', { serialUnitId: installed[0].id, defectAr: 'نقاط ساخنة ظاهرة بالتصوير الحراري', defectEn: 'Hotspots visible on thermal imaging' }),
    );
    if (claim) await step('تقديم البلاغ للمصنّع', () => call('POST', `/fsm/warranty-claims/${claim.id}/submit`, {}));
  }

  console.log('\n— Demo data complete —');
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
