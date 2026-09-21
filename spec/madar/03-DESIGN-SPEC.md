# 03 — Design Specification (Delta)
**Project:** Madar — Conversational layer for NPI ERP | **Package version:** 3.0 | **Date:** 2026-09-21

## 1. Visual direction
Lives beside NPI's web app, so it must feel like part of it: NPI's `ink` dark sidebar, `brand` teal and `solar` amber tokens are reused from `apps/web/tailwind.config` (read them at T-07; do not invent a palette). Approval/preview cards keep the gold edge (`#C9A227`) from the owner's deck as the one distinctive element. Font: IBM Plex Sans Arabic (already self-hosted in `apps/web`; copy the font files, same `next/font` setup). Numbers Latin, Gregorian (`ar-SA-u-nu-latn-ca-gregory`) — NPI convention. RTL with logical utilities.

## 2. Components
`AppShell` (NPI-like header, «العودة إلى NPI» link, bottom tabs on mobile) · `Chat`/`Message`/`Composer` (attach button: file + camera on mobile; mic) · `WaitingIndicator` («أقرأ المستند… صفحة 2 من 5») · `DocumentChip` (name, kind badge: نصي/ممسوح/صورة, sensitivity) · `ConsentCard` (image send notice, provider policy line, «اعتمد الإرسال»/«ألغِ») · `PreviewCard` (flow title, grouped fields, confirmed ✓ / unconfirmed ⚠ with evidence tooltip, inline edit, «ما سيُنفَّذ» list, buttons اعتمد/عدّل/ألغِ) · `ExecutionCard` (steps with NPI codes and links, failure with created ids) · `MemoryNote` · `AssistantBadge` (flow/tool name) · `SetupStep`/`ProfileCard`/`DiffCard` («سأضبط في NPI: …») · `PositionCard`/`HandoverDoc` · `AuditTable` (+ column «صورة أُرسلت») · `MetricCard` ×6 · states (Empty/Error/Skeleton).

## 3. Screens — four states
| Screen | Normal | Empty | Loading | Error |
|---|---|---|---|---|
| Login | NPI credentials | — | spinner | «بيانات الدخول غير صحيحة» / «محاولات كثيرة» / «NPI غير متاح حالياً» |
| Home+Chat | greeting, 4 tiles from NPI, chat | «ابدأ: أرفق عقداً أو اكتب «طلب شراء…»» + 3 chips | tiles skeleton; chat waiting | «تعذر الوصول إلى NPI» retry |
| Document | preview + execution | — | «أقرأ المستند…» | «تعذر قراءة المستند؛ جرّب صورة أوضح» |
| Setup | 7 steps + diff | first run | «أفهم إجابتك…» | «تعذر تطبيق الإعداد في NPI: {reason}» (partial results listed) |
| Settings / Trust / Metrics / Handover | as 2.0 | as 2.0 | as 2.0 | as 2.0 |

## 4. Arabic UI strings (canonical, `src/i18n/ar.ts`) — additions to 2.0 set
```
app.name = مَدار — مساعد NPI | nav.back_to_npi = العودة إلى NPI
home.tile.inbox = مهام بانتظار اعتمادك | home.tile.contracts_draft = عقود بانتظار التفعيل | home.tile.pr_pending = طلبات شراء معلقة | home.tile.bills_unmatched = فواتير موردين بانتظار المطابقة
chat.attach = أرفق مستنداً | chat.camera = صوّر المستند | chat.suggest.1 = أرفق عقداً جديداً وسأُدخله | chat.suggest.2 = طلب شراء: 40 لوح 550 واط للمشروع PRJ-00012 | chat.suggest.3 = وش المهام اللي تنتظرني؟
intake.reading = أقرأ المستند… صفحة {n} من {total} | intake.kind.pdf_text = ملف نصي | intake.kind.pdf_scanned = ممسوح ضوئياً | intake.kind.image = صورة
intake.refused_confidential = هذا المستند موسوم «سري» ولن يُرسل إلى أي نموذج خارجي. يمكنك إدخاله من شاشة NPI.
consent.title = سيُرسل هذا المستند كصورة إلى مزوّد النماذج | consent.body = لا يمكن إخفاء الأسماء في الصور قبل الإرسال. {policy_line} سيُسجَّل هذا الإرسال في سجل الثقة. | consent.approve = اعتمد الإرسال | consent.cancel = ألغِ | consent.policy_unverified = (سياسة المزوّد قيد التحقق)
flow.customer_contract = عميل وعقد | flow.pr = طلب شراء | flow.po = أمر شراء | flow.grn = استلام بضاعة | flow.vendor_bill = فاتورة مورد | flow.unknown = لم أحدد نوع المستند — اختر:
preview.title = هذا ما سأُدخله في NPI | preview.confirmed = مؤكد | preview.unconfirmed = غير مؤكد — أكّده | preview.evidence = المصدر: صفحة {page}: «{quote}» | preview.will_execute = ما سيُنفَّذ بالترتيب | preview.approve = اعتمد | preview.edit = عدّل | preview.cancel = ألغِ | preview.edit_prompt = اكتب التعديل بجملة (مثال: القيمة 850,000 والمحتجزات 10%)
preview.customer_match = وجدت عميلاً مطابقاً: {name} — استخدمه؟ | preview.customer_new = عميل جديد سيُنشأ | preview.item_new = صنف جديد سيُقترح إنشاؤه
exec.running = أُنفّذ في NPI… | exec.done = تم. {entity} برقم {code} | exec.failed = توقفت عند الخطوة {n}: NPI رفض: {reason}. ما أُنشئ حتى الآن: {created} | exec.after_matrix = سيمر الآن بمصفوفة الاعتمادات كالمعتاد
setup.q1 = ما نشاط المنشأة وخطوط إيرادها؟ | setup.q2 = ما الأقسام والمناصب؟ ومن يشغلها من مستخدمي NPI؟ | setup.q3 = ما سقوف الاعتماد لكل مستند؟ | setup.q4 = ما المستندات التي ستُدخلها بالمحادثة؟ | setup.q5 = ما الأصناف الشائعة؟ | setup.q6 = هل تفضّل مصطلحات معينة؟ | setup.diff = سأضبط في NPI | setup.gap = لا تتيحه واجهة NPI حالياً
profile.epc = مقاول EPC (تصميم وتوريد وتركيب) | profile.om_provider = مزوّد تشغيل وصيانة | profile.ppa_operator = مشغّل بيع طاقة/تأجير | profile.general_contracting = مقاولات عامة | profile.equipment_trading = تجارة معدات | profile.engineering_consulting = استشارات هندسية
trust.col.image_sent = صورة أُرسلت | metrics.a5 = الإدخال بالمحادثة | metrics.a6 = التشكّل الذاتي | metrics.baseline = الزمن اليدوي المرجعي (يُقاس مرة): {value}
hr.refusal = هذا قرار بشري يخص أداء الموظفين، ولا أقدّم فيه تقييماً أو توصية.
```

## 5. Profile packs (content, T-14/T-15)
| key | visible modules | departments | approval defaults | doc types | items |
|---|---|---|---|---|---|
| epc | crm, commercial, projects, procurement, finance | المبيعات، المشاريع، المشتريات، المالية، الموقع | PR ≥ 10k [pm]; PO ≥ 100k [pm→accountant]; claim ≥ 250k | عقد EPC، عرض مورد، إشعار تسليم، فاتورة مورد | ألواح، عواكس، هياكل، كابلات |
| om_provider | crm, commercial, fsm, procurement, finance | التشغيل، الصيانة، المشتريات، المالية | PR ≥ 5k; PO ≥ 50k | عقد صيانة، طلب قطع، فاتورة مورد | قطع غيار، ساعات عمل |
| ppa_operator | commercial, ppa, telemetry, fsm, finance | التشغيل، المالية | PO ≥ 50k | عقد PPA، فاتورة مورد | — |
| general_contracting | crm, commercial, projects, procurement, finance | كما epc | كما epc بسقوف أعلى | عقد مقاولة، مستخلص، فاتورة مورد | مواد بناء |
| equipment_trading | crm, commercial, procurement, finance | المبيعات، المستودع، المالية | PO ≥ 30k | عرض مورد، إشعار تسليم، فاتورة مورد | أصناف تجارية |
| engineering_consulting | crm, commercial, projects, finance | الهندسة، المالية | PO ≥ 20k | عقد خدمات، فاتورة مورد | ساعات استشارة |

## 6. Evaluation document set (F-20, `eval/extract/`)
20 documents: 6 contracts (3 PDF text, 2 scanned, 1 photo), 4 supplier quotes, 4 delivery notes (photos), 6 vendor bills (3 PDF, 3 images). Each with `expected.json` (NPI DTO fields). Synthetic or owner-supplied with real names removed. Never commit real customer data.

## 7. Assets
IBM Plex Sans Arabic (OFL, already in repo) · lucide-react (ISC) · NPI logo (owner's) · no other assets.
