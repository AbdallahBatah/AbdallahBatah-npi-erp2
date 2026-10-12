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
/** Run `fn` with another user's token (the executive signs what the salesperson raises), then restore. */
const tokens = new Map(); // one login per user: the login route is rate-limited
async function asUser(email, password, fn) {
  const saved = TOKEN;
  try {
    if (!tokens.has(email)) {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`login ${email} → ${res.status}: ${json?.message}`);
      tokens.set(email, json.accessToken);
    }
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

(async () => {
  const login = await call('POST', '/auth/login', { email: 'admin@npi.sa', password: 'Admin@123' });
  TOKEN = login.accessToken;

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
  if (leads[0] && leads[0].status === 'NEW')
    await step('تحويل عميل محتمل → فرصة', () => call('POST', `/leads/${leads[0].id}/convert`, {}));

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
      asUser('ceo@npi.sa', 'Ceo@12345', async () => {
        const inbox = await call('GET', '/approvals/inbox');
        const row = inbox.find((r) => r.documentType === 'PROPOSAL' && r.documentId === p.id);
        if (!row) throw new Error('not in the executive inbox');
        return call('POST', `/approvals/${row.id}/decide`, { decision: 'APPROVE', note: 'اعتماد العرض' });
      }),
    );
    if (!signed) return;
    const sent = await step(`إرسال العرض للعميل: ${name}`, () => call('POST', `/proposals/${p.id}/send`, {}));
    if (!sent || upTo === 'sent') return;
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

    // ── 5. Project #2 → PO → receive w/ serials → bill → install ──────────
    let prj2 = (await call('GET', '/projects')).find((p) => p.contractId === contract2.id);
    if (!prj2) prj2 = await step('مشروع المستشفى', () => call('POST', '/projects', { contractId: contract2.id }));
    if (prj2) {
      const vendors = await call('GET', '/procurement/vendors');
      const po = await step('أمر شراء 60 لوح', () =>
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
        await step('اعتماد أمر الشراء', () => call('POST', `/procurement/purchase-orders/${po.id}/approve`, {}));
        const poFull = await call('GET', `/procurement/purchase-orders/${po.id}`);
        const modLine = poFull.lines.find((l) => l.item.sku === 'MOD-550');
        const railLine = poFull.lines.find((l) => l.item.sku === 'MNT-RAIL');
        const serials = Array.from({ length: 20 }, (_, i) => `DEMO-MOD-${String(i + 1).padStart(3, '0')}`);
        const grn = await step('استلام جزئي (20 لوح + قضبان)', () =>
          call('POST', `/procurement/purchase-orders/${po.id}/receive`, {
            lines: [
              { poLineId: modLine.id, qty: 20, serials },
              { poLineId: railLine.id, qty: 120 },
            ],
          }),
        );
        if (grn) await step('ترحيل فاتورة المورد', () => call('POST', '/procurement/bills', { goodsReceiptId: grn.id }));
        const units = await call('GET', '/procurement/serial-units?state=IN_STOCK');
        const demoUnits = units.filter((u) => u.serialNo.startsWith('DEMO-MOD-')).slice(0, 8);
        for (const u of demoUnits) await step(`تركيب ${u.serialNo}`, () => call('POST', `/procurement/serial-units/${u.id}/install`, {}));
      }

      // Subcontract + claim
      const sub = await step('عقد باطن أعمال مدنية', () =>
        call('POST', '/procurement/subcontracts', {
          vendorId: vendors[0].id, projectId: prj2.id,
          scopeAr: 'الأعمال المدنية وقواعد الهياكل', scopeEn: 'Civil works & foundations',
          amount: 180000, retentionPct: 10,
        }),
      );
      if (sub) {
        const claim = await step('مستخلص أول 60,000', () => call('POST', `/procurement/subcontracts/${sub.id}/claims`, { claimedAmount: 60000 }));
        if (claim) await step('اعتماد المستخلص', () => call('POST', `/procurement/claims/${claim.id}/approve`, {}));
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
