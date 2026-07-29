# نظام NPI للطاقة الشمسية — ERP
# NPI Solar ERP

نظام ERP رأسي للطاقة الشمسية أصيل الامتثال السعودي (ZATCA-native)، مبني وفق [مواصفة البناء الموحّدة](./Solar_ERP_Unified_Build_Specification_AR_EN.md).
هذا المستودع يحتوي **أساس النظام (W0)** و**الشريحة العمودية الأولى العاملة (W1): من عميل محتمل إلى عقد**.

A ZATCA-native vertical solar ERP for the Saudi/GCC market. This repository contains the **foundation (W0)** and the **first working vertical slice (W1): lead → contract**.

> **الحالة / Status:** يبني ويعمل ✅. تم التحقق من بناء الحزم الثلاث (`shared`, `api`, `web`) بنجاح. لم يتم تشغيل قاعدة البيانات داخل بيئة التطوير الأصلية (لا يوجد Docker/Postgres مثبّت)، لذا اتبع خطوات التشغيل أدناه لتشغيلها لديك.

---

## ما الذي بُني في هذه المرحلة / What was built

| الموجة / Wave | المحتوى / Contents | الحالة |
|---|---|---|
| **W0 — Foundation** | تعدد المستأجرين (`Organization`)، صلاحيات قائمة على الدور (RBAC)، ترقيم مستندات نظامي، سجل تدقيق append-only، واجهة عربية/إنجليزية RTL، مصادقة JWT | ✅ |
| **W1 — Sell & Contract** | العملاء المحتملون (CRM-01) ← الفرص (CRM-02) ← التصميم/قائمة المواد/العرض (DSN-01/03/04) ← العقد ومراحله (DSN-05) | ✅ |
| **W3 — Bill & Comply** | دفتر أستاذ وقيد مزدوج (FIN-01)، **فوترة ZATCA المرحلة الثانية** (FIN-02: UUID + سلسلة تجزئة PIH + QR TLV + ختم تشفيري ECDSA)، ضريبة 15% (FIN-03)، فوترة مرتبطة بالمراحل (FIN-04)، **الاعتراف بالإيراد IFRS-15 بنسبة الإنجاز** (FIN-05: أصل عقد 1150 / إيراد مؤجل 2400 بقيود تسوية تراكمية ذاتية التصحيح)، **ربحية العقود** (FIN-07)، **إقرار ضريبة القيمة المضافة**، سجل المحتجزات (FIN-13) | ✅ |
| **W2 — Deliver & Cost** | مشروع من عقد + WBS بموازنة من BOM (PRJ-01/02/04)، تكلفة الوظيفة: موازنة/ملتزم/فعلي (PRJ-03)، الموردون وأوامر الشراء بالتكلفة الملتزمة (SCM-01/02)، الاستلام GRN وتسجيل **`SerialUnit`** ككيان جسر (SCM-05)، سجل تكاليف **append-only**، فاتورة المورد بقيد (مدين WIP 1300 + ضريبة مدخلات 1400 / دائن ذمم موردين 2000) تغذّي إقرار الضريبة، سجل أصول أولي بالتركيب (AST-01)، **أوامر التغيير** بأثر القيمة والموازنة (PRJ-06)، **مقاولو الباطن والمستخلصات** بمحتجزات دائنة 2050 (PRJ-07)، **مخزون متعدد المواقع** بمستويات وحركات وتحويلات (SCM-04) | ✅ |
| **W4 — Operate** | **سجل الأصول الهرمي** يولَّد تلقائياً عند التركيب: محطة ← معدّة مرتبطة بـ`SerialUnit` (AST-01)، **أوامر عمل** تصحيحية/وقائية بدورة حياة كاملة وإسناد فنيين وSLA (FSM-01/05)، **استهلاك قطع الغيار** من المخزون متعدد المواقع بقيد تكلفة O&M على المشروع (بذرة SCM-07)، **خطط صيانة وقائية** تولّد الأوامر المستحقة وتُقدّم الاستحقاق دون انجراف (FSM-02)، **قوائم فحص** ببنود إلزامية تُفرض عند الإنجاز (FSM-04)، والأصل يتنقل تلقائياً بين «عامل ↔ تحت الصيانة» | ✅ |
| **W5 — Connect the plant** | **جسر القياس إلى المال**: قراءات إنتاج يومية لكل أصل مع معامل الأداء PR مقابل المتوقع من التصميم (TEL-01/02)، محرك قواعد عند الاستيعاب: توقف إنتاج/PR<50% ← إنذار **حرج**، PR<80% ← تحذير (TEL-03/04) مع كبت التكرار، **FSM-11**: الإنذار الحرج يولّد أمر عمل تصحيحياً تلقائياً بمهلة استجابة 48 ساعة، **وإغلاق أمر العمل يحلّ الإنذار تلقائياً** — الحلقة الكاملة: قراءة ← إنذار ← أمر عمل ← تكلفة ← حل، وسجل تشغيلي لكل أصل: إنتاج + إنذارات + أوامر عمل (AST-02). الموصل محاكاة حتى تُبنى خدمة التكامل (§5.1) | ✅ |
| **W6 — Recurring revenue** | **شروط PPA** على عقد PPA/OM أو بإنشاء عقد تلقائي (PPA-01)، **محرك تعرفة** بتصعيد سنوي مركّب (PPA-02)، **تسوية لكل ك.و.س** (PPA-03): قراءات محطة المشروع في الفترة × التعرفة المطبقة + رسم ثابت (PPA-07) ← فاتورة **تسوية** بضريبة 15% تمر عبر مسار ZATCA نفسه (سلسلة PIH وQR والقيود) — كل تسوية قابلة لإعادة الاحتساب من مدخلاتها المخزنة، مع حراسة تداخل الفترات ومنع تسوية فترة بلا قراءات | ✅ |
| **W7 — Harden** | **مطالبات الضمان RMA** (FSM-09): عطل ← مطالبة للمصنّع ← اعتماد ← **استبدال يبدّل الرقم التسلسلي تحت نفس الأصل** فيبقى السجل التشغيلي محفوظاً، **المدفوعات** (مدين بنك 1000 / دائن ذمم 1100، الفاتورة ← مدفوعة عند السداد الكامل، حراسة تجاوز الرصيد)، **الإفراج عن المحتجزات** (مدين 1100 / دائن 1200 ويُعاد فتح الفاتورة للتحصيل)، **ساعات العمل الميدانية** (FSM-07): سجل ساعات على أمر العمل ← تكلفة عمالة فعلية على المشروع | ✅ |

كل ميزة مرتبطة بمعرّفها في المواصفة. الوحدات القادمة (المشتريات، المالية/ZATCA، التشغيل والصيانة، المراقبة، عقود شراء الطاقة) تتصل بنفس العمود الفقري — انظر [خارطة الطريق](#خارطة-الطريق--roadmap).

---

## البنية / Architecture

مونوليث معياري (modular monolith) كما توصي المواصفة (§5) — قابل للنشر كأداة واحدة داخل المملكة.

```
apps/
  api/     NestJS — المونوليث المعياري (المصادقة، CRM، التجاري، المرجعية)
  web/     Next.js 14 (App Router) — واجهة RTL-first ثنائية اللغة
packages/
  db/      Prisma schema (~26 كياناً) + الترحيلات + بيانات البذرة
  shared/  الصلاحيات + قوائم القيم ثنائية اللغة (مصدر حقيقة واحد)
```

**قرارات محورية مطبّقة من المواصفة:**
- `organizationId` على كل جدول (عزل المستأجر على مستوى الصف).
- `AuditLog` و`ProjectCostEntry`* غير قابلة للتعديل (append-only).
- `SerialUnit` مصمَّم ككيان جسر (سيُفعّل في W2) لا كحقل نصي.
- ترقيم نظامي بلا فجوات (`NumberingSequence`) داخل معاملة ذرية.
- بيانات مرجعية ثنائية اللغة بحقلين `*_ar` / `*_en`.

\* الكيانات المتقدمة موجودة في تصميم المواصفة وتُضاف في موجاتها.

---

## المتطلبات / Prerequisites

- **Node.js ≥ 20** (تم التطوير على 22.x)
- **PostgreSQL 16** — عبر Docker (موصى به) أو تثبيت محلي أو أي Postgres متاح.

---

## التشغيل خطوة بخطوة / Getting started

### 1) تثبيت الاعتماديات / Install
```bash
npm install
```

### 2) إعداد البيئة / Environment
انسخ ملف المثال (تم إنشاؤه مسبقاً باسم `.env`؛ عدّله إن لزم):
```bash
cp .env.example .env
```

### 3) تشغيل قاعدة البيانات / Start Postgres

**مُثبّتة مسبقاً على هذا الجهاز ✅** — تم تثبيت PostgreSQL 16.6 محمول في `C:\Users\eyadq\.npi-erp` (خارج OneDrive)، والقاعدة `npi_erp` جاهزة ومُرحّلة ومبذورة. لتشغيلها/إيقافها:
```bash
npm run db:start     # تشغيل الخادم على localhost:5432
npm run db:stop      # إيقافه
```
> إن نقلت مجلد `.npi-erp` عدّل المسارين في `db:start` / `db:stop` بملف `package.json` الجذر.

بدائل: `docker compose up -d`، أو أي Postgres آخر مع تحديث `DATABASE_URL` في `.env`.

### 4) الترحيل والبذرة / Migrate & seed
```bash
npm run db:migrate      # يطبّق المخطط على قاعدة البيانات
npm run db:seed         # ينشئ مستأجر NPI + مستخدمين + كتالوج + عميل محتمل تجريبي
```

### 5) التشغيل / Run (نافذتان طرفيتان)
```bash
npm run dev:api         # ➜ http://localhost:4000/api
npm run dev:web         # ➜ http://localhost:3000
```

### حسابات الدخول التجريبية / Demo logins
| الدور | البريد | كلمة المرور |
|---|---|---|
| مدير النظام / Admin | `admin@npi.sa` | `Admin@123` |
| مبيعات / Sales | `sales@npi.sa` | `Sales@123` |

---

## جولة في الشريحة العاملة / The working slice, end to end

1. **العملاء المحتملون** — أنشئ عميلاً محتملاً، ثم اضغط «تحويل إلى فرصة» (ينشئ عميلاً وفرصة ويربطها).
2. **الفرص** — من الفرصة اضغط «إنشاء عرض».
3. **العرض** — أضف مراجعة: اختر مخطط تسعير، أدخل قائمة المواد (BOM) من الكتالوج، وأدخل بيانات التصميم اختيارياً. يُحسب المجموع والهامش والإجمالي تلقائياً. ثم **اعتمد المراجعة**.
4. **إنشاء عقد** — من المراجعة المعتمدة، حدّد نوع العقد والمحتجزات والدفعة المقدمة والمراحل. يُنشأ العقد وترتقي الفرصة إلى «مكسوبة».
5. **العقد** — فعّل العقد، ثم **تحقّق** من كل مرحلة (هذه هي النقطة التي ستتصل بها فوترة ZATCA المرحلية FIN-04 في W3).

كل خطوة تُسجَّل في `AuditLog`، وكل مستند يأخذ رقماً نظامياً متسلسلاً.

---

## أهم نقاط الـ API / Key API endpoints

```
POST   /api/auth/login                              دخول (عام)
GET    /api/auth/me                                 المستخدم الحالي
GET    /api/reference/enums | pricing-schemes | dashboard

GET/POST/PATCH  /api/customers
GET/POST/PATCH  /api/leads      · POST /api/leads/:id/convert
GET/POST/PATCH  /api/opportunities
GET/POST/PATCH  /api/items

GET/POST  /api/proposals
POST      /api/proposals/:id/revisions
POST      /api/proposals/:id/revisions/:revisionId/accept

GET/POST  /api/contracts
POST      /api/contracts/:id/activate
POST      /api/contracts/:id/milestones/:milestoneId/verify

# Finance & ZATCA (W3)
POST   /api/finance/contracts/:cId/milestones/:mId/invoice   إنشاء فاتورة من مرحلة مُتحقّقة
POST   /api/finance/invoices/:id/issue                       اعتماد + توليد فاتورة ZATCA + قيد اليومية
GET    /api/finance/invoices | invoices/:id | journal | retention | summary

# Finance reports (W3 — remainder)
GET    /api/finance/reports/poc                              IFRS-15 نسبة الإنجاز لكل عقد
POST   /api/finance/reports/poc/:contractId/recognize        ترحيل قيد الاعتراف التزايدي (1150/2400 ↔ 4000)
GET    /api/finance/reports/vat-return?from&to               إقرار الضريبة (مخرجات من الفواتير + مدخلات من فواتير الموردين)
GET    /api/finance/reports/profitability                    ربحية العقود (تقديرية BOM + فعلية من سجل تكاليف المشروع)

# Projects & Procurement (W2)
GET/POST  /api/projects                                      مشروع من عقد نشط (WBS مُوازَن من BOM)
GET       /api/projects/:id                                  التفاصيل + موازنة/ملتزم/فعلي لكل WBS
POST      /api/projects/:id/stage                            نقل مرحلة المشروع
GET/POST  /api/procurement/vendors
GET/POST  /api/procurement/purchase-orders                   أمر شراء مرتبط بمشروع/WBS
POST      /api/procurement/purchase-orders/:id/approve       اعتماد (يُظهر التكلفة الملتزمة)
POST      /api/procurement/purchase-orders/:id/receive       استلام GRN + أرقام تسلسلية + قيود تكلفة append-only
POST      /api/procurement/bills                             فاتورة مورد: قيد WIP + ضريبة مدخلات / ذمم موردين
GET       /api/procurement/serial-units                      سجل الوحدات المتسلسلة
POST      /api/procurement/serial-units/:id/install          تركيب (المخزون ← أصل عامل)

# W2 remainder
POST      /api/projects/:id/change-orders                    أمر تغيير (PRJ-06)
POST      /api/projects/change-orders/:coId/approve          اعتماد: يعدّل قيمة العقد وموازنة WBS
GET/POST  /api/procurement/subcontracts                      اتفاقيات مقاولة الباطن (PRJ-07)
POST      /api/procurement/subcontracts/:id/claims           مستخلص جديد (سقف = قيمة الاتفاقية)
POST      /api/procurement/claims/:id/approve                اعتماد: تكلفة فعلية + قيد AP + محتجزات 2050
GET       /api/procurement/locations | stock                 المواقع ومستويات المخزون (SCM-04)
POST      /api/procurement/transfers                         تحويل رقم تسلسلي أو كمية بين المواقع

# O&M / Field Service (W4)
GET       /api/fsm/assets | technicians                      سجل الأصول الهرمي + طاقم الميدان
GET       /api/fsm/work-orders | work-orders/summary | :id
POST      /api/fsm/work-orders                               أمر عمل (تصحيحي/وقائي/تنظيف/فحص)
POST      /api/fsm/work-orders/:id/assign|start|complete|close|cancel
POST      /api/fsm/work-orders/:id/parts                     استهلاك قطعة من موقع مخزون + قيد تكلفة O&M
GET/POST  /api/fsm/plans                                     خطط الصيانة الوقائية (قوائم فحص ببنود إلزامية)
POST      /api/fsm/plans/generate-due                        توليد أوامر العمل المستحقة وتقديم الاستحقاق

# Telemetry bridge (W5)
POST      /api/telemetry/readings                            استيعاب قراءات (تقيّم القواعد وتولّد الإنذارات)
POST      /api/telemetry/simulate                            موصل محاكاة: نافذة قراءات لمحطة مشروع
GET       /api/telemetry/dashboard | readings | alerts
POST      /api/telemetry/alerts/:id/acknowledge|work-order   تأكيد / أمر عمل يدوي (الحرج تلقائي)
GET       /api/telemetry/assets/:id/history                  السجل التشغيلي للأصل (AST-02)

# PPA & settlement (W6)
GET/POST  /api/ppa/terms                                     شروط PPA (تعرفة + تصعيد + رسم ثابت)
POST      /api/ppa/terms/:id/settle                          تسوية فترة ← فاتورة SETTLEMENT (تُعتمد عبر مسار ZATCA)
GET       /api/ppa/runs                                      جولات التسوية وفواتيرها

# W7: RMA, payments, labour
GET/POST  /api/fsm/warranty-claims                           مطالبة ضمان (تعلّم الوحدة والأصل FAULTY)
POST      /api/fsm/warranty-claims/:id/submit|approve|reject|replace
POST      /api/fsm/work-orders/:id/time                      ساعات ميدانية ← تكلفة عمالة على المشروع
POST      /api/finance/invoices/:id/payments                 دفعة عميل (بنك/ذمم؛ ← PAID عند الاكتمال)
POST      /api/finance/retention/:id/release                 الإفراج عن المحتجزات (← ذمم مستحقة)
```
كل المسارات (عدا `login`) تتطلب `Authorization: Bearer <token>` وتُفلتَر بصلاحية الدور و`organizationId`.

---

## أوامر مفيدة / Useful commands

```bash
npm run build           # بناء الحزم الأربع بالترتيب الصحيح
npm run typecheck       # فحص الأنواع في كل الحزم
npm run db:studio       # Prisma Studio لتصفح البيانات
npm run db:push         # دفع المخطط دون ترحيلات (للتطوير السريع)
```

---

## خارطة الطريق / Roadmap

الشريحة الحالية هي W0+W1. الموجات التالية (من §3.2 في المواصفة) تُبنى على نفس العمود الفقري:

| الموجة | المحتوى | الحالة / نقطة الاتصال |
|---|---|---|
| **W3 — Bill & Comply** | دفتر الأستاذ، فوترة ZATCA، ضريبة 15%، المحتجزات، IFRS-15 نسبة الإنجاز، إقرار الضريبة، الربحية | ✅ مكتملة |
| **W2 — Deliver & Cost** | المشاريع وWBS، المشتريات وGRN، `SerialUnit` الجسر، سجل التكاليف append-only، فواتير الموردين وضريبة المدخلات، أوامر التغيير، مقاولو الباطن والمستخلصات، المخزون متعدد المواقع | ✅ مكتملة |
| **W4 — Operate** | أوامر العمل، الصيانة الوقائية، قوائم الفحص، سجل الأصول | ✅ مبنية — يتبقّى التطبيق الميداني دون اتصال (FSM-03) |
| **W5 — Connect the plant** | جسر القياس إلى المال: قراءات ← إنذار ← أمر عمل ← حل | ✅ مبنية — الموصلات الفعلية عبر خدمة التكامل (§5.1) |
| **W6 — Recurring revenue** | شروط PPA والتعرفة والتصعيد والتسوية لكل ك.و.س وفوترتها | ✅ مبنية |

**ملاحظة ZATCA:** توليد الفاتورة الإلكترونية (XML بصيغة UBL 2.1، سلسلة تجزئة PIH، QR TLV، ختم ECDSA) حقيقي بنيوياً، لكن **الاعتماد محاكاة** والمفتاح مُولّد محلياً لا شهادة CSID من الهيئة. نقطة الاستبدال معزولة في [`zatca.service.ts`](apps/api/src/modules/finance/zatca.service.ts) (`getSigningKey` + وضع `submit`) — استبدلها بشهادة CSID عبر KMS/HSM للإرسال الفعلي (§5.6).

الخدمات الأربع المفصولة في المواصفة (القياس، التكامل، الامتثال/ZATCA، مزامنة الموبايل) تبقى خارج المونوليث وتُضاف عند موجاتها.

---

## ملاحظات / Notes

- **تم التحقق من النظام بالكامل end-to-end ✅:** PostgreSQL 16.6 محلي، تطبيق الترحيل والبذرة، ثم اختبار المسار الكامل عبر HTTP: تسجيل دخول ← عميل محتمل ← تحويل لفرصة ← عرض بقائمة مواد وهامش (1,008,003.20 ر.س) ← اعتماد ← عقد EPC ← تفعيل ← التحقق من مرحلة ← الفرصة أصبحت «مكسوبة». كل البيانات محفوظة في Postgres وظاهرة في واجهة الويب.
- **الأمان:** غيّر `JWT_SECRET` و`POSTGRES_PASSWORD` في أي بيئة غير تطويرية. مفاتيح ZATCA (في W3) يجب أن تُدار عبر KMS/HSB لا في قاعدة البيانات (§5.6).
- `npm audit` يُظهر تنبيهات في اعتماديات فرعية؛ روجِعت نسخة Next.js إلى الإصدار المُصحَّح (14.2.35).
