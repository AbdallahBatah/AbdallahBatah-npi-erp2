# تقرير التحقق — المرحلة صفر (Madar Copilot)

**المهمة:** T-00a | **الفرع:** `fix/phase0` | **تاريخ الإعداد:** 2026-09-21
**المرجع:** `spec/madar/05-IMPLEMENTATION-PLAN.md` (T-00a)، `spec/madar/02-TECH-SPEC.md` §0/§1، `spec/madar/07-GOAL-CONDITIONS.md` (G-0-1)، `docs/PROJECT_DOSSIER_AR.md` §9.5/§10.2/§14.1

> هذا الملف **تحقّق وتوثيق فقط**. لا يُصلح أي عيب — العيبان 14.1#1 و14.1#2 من مسؤولية T-00b وT-00c. كل بند أدناه مسنود بدليل: `ملف:سطر`، اسم اختبار، أو رابط+تاريخ.

---

## جدول الملخص

| # | البند | الحالة | الدليل الأساسي |
|---|---|---|---|
| 1 | نسخة Node التي يعمل عليها NPI | ✅ متحقق | `package.json:29`، `apps/api/Dockerfile:4,22`، `apps/web/Dockerfile:4,23`، `.github/workflows/ci.yml:21` — لا يوجد `.nvmrc` |
| 2 | إتاحة `/api/docs-json` | ⚠️ متحقق جزئياً (استاتيكياً فقط) | `apps/api/src/main.ts:56` — التشغيل الفعلي **غير متحقق** (Postgres متوقف) |
| 3 | أشكال DTO للتدفقات الخمسة | ✅ متحقق | ملفات الـDTO والمتحكمات لكل تدفق (تفصيل أدناه) |
| 4 | `POST /api/contracts` والمراحل — ضمنياً أم نداءات منفصلة؟ | ✅ متحقق — **ضمنياً** | `apps/api/src/modules/commercial/dto.ts:77-90`، `contracts.service.ts:108-123` |
| 5 | عيب 14.1#1 (الترقيم عند 1 يناير) | ✅ متحقق — **مُثبَت (REPRODUCED)** | `apps/api/src/common/numbering.service.ts:19-40`، `packages/db/prisma/seed.ts:83,219-238`، `packages/db/prisma/schema.prisma` (قيود `@@unique([organizationId, code])` المتعددة) |
| 6 | عيب 14.1#2 (تجاوز مصفوفة الاعتماد) | ✅ متحقق — **مُثبَت (REPRODUCED)** | `apps/api/src/modules/procurement/requisitions.service.ts:258-278`، `apps/api/src/common/workflow/workflow.engine.ts:245-322`، `packages/db/prisma/seed.ts:629-636` |
| 7 | سياسة استخدام بيانات المزوّد (Anthropic) | ✅ متحقق | مقتبس أدناه بالرابط والتاريخ |
| 8 | حالة بوابات الاختبار على `main` | ⚠️ جزئي حسب ما زوّده المشغّل؛ لم أُعِد تشغيلها بنفسي | تفصيل أدناه؛ `npm run test:int` **غير متحقق** (Postgres متوقف) |

---

## ١. نسخة Node

- لا يوجد ملف `.nvmrc` في جذر المستودع (تم التحقق بمحاولة قراءته — غير موجود).
- جذر `package.json:28-30`:
  ```json
  "engines": {
    "node": ">=20"
  }
  ```
- `apps/api/Dockerfile:4` و`:22`: `FROM node:20-alpine` (مرحلتا البناء والتشغيل).
- `apps/web/Dockerfile:4` و`:23`: `FROM node:20-alpine` (نفس النمط).
- `.github/workflows/ci.yml:21`: `node-version: 20` (خطوة `actions/setup-node@v4`).
- `apps/api/package.json` و`apps/web/package.json`: لا حقل `engines` خاص بهما (لم يُعثر على المطابقة).
- الجهاز المحلي الحالي: `node -v` → **v24.19.0**، `npm -v` → **11.17.0** (نُفِّذ فعلياً في هذه الجلسة).

**الأثر على حاوية الكوبايلوت:** NPI نفسه (API وWeb وCI) مثبَّت وموثَّق على **Node 20**، بينما جهاز التطوير الحالي يشغّل **Node 24.19.0** — فارق نسختين رئيسيتين. بما أن `apps/copilot` مشروع منفصل بحاوية Docker خاصة (§11 من `02-TECH-SPEC.md`)، فلا يوجد ما يُلزمه بمطابقة Node الخاص بـ`apps/api`/`apps/web` (لا Prisma schema مشتركة تُبنى بنفس عملية node، ولا استيراد مباشر لشيفرة NPI)؛ القرار الموثّق في `02-TECH-SPEC.md §1` هو تثبيت الكوبايلوت على `node:24-alpine` بشكل مستقل — وهذا متسق مع كون الجهاز المحلي بالفعل على 24. **لا حاجة لتخفيض نسخة الكوبايلوت إلى 20** طالما بقي تكامله مع NPI عبر HTTP فقط (`npi/client.ts`) لا عبر حزم Node مشتركة.

---

## ٢. إتاحة `/api/docs-json`

`apps/api/src/main.ts:44-56`:
```
const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
...
SwaggerModule.setup('api/docs', app, openApiDocument);
```
- `app.setGlobalPrefix('api')` مضبوط في `main.ts:18`، لكنه لا يؤثر على `SwaggerModule.setup` لأن الأخير يسجَّل مباشرة على HTTP adapter لا عبر نظام المتحكمات — ولهذا كُتب المسار صراحة `'api/docs'` (لا `'docs'`) ليصبح فعلياً على `/api/docs`، وهو ما يطابق ملاحظة `docs/PROJECT_DOSSIER_AR.md §10.2 بند 3` («`/api/docs` مكشوف للعامة»).
- سلوك NestJS الافتراضي لـ`SwaggerModule.setup(path, app, document)` (لم يُمرَّر أي `SwaggerCustomOptions.jsonDocumentUrl` مخصَّص هنا) هو تعريض وثيقة JSON تلقائياً على `${path}-json` — أي **`/api/docs-json`**.
- لا وجود لأي شرط بيئة (`EXPOSE_API_DOCS` أو ما شابه) يحجب هذا المسار حالياً — تم البحث عن `EXPOSE_API_DOCS` في كامل المستودع (خارج `node_modules`) ولم يظهر أي سطر شيفرة يستخدمه؛ هذا العلم هو موضوع مهمة أخرى (T-00d)، وليس موجوداً بعد.

**الخلاصة الاستاتيكية:** `/api/docs-json` **متوقع أن يعمل** بمجرد تشغيل الـAPI، بلا أي حماية حالياً.

**غير متحقق (يحتاج تشغيلاً فعلياً):** تأكيد رد HTTP فعلي (curl على `http://localhost:4000/api/docs-json`) — **لم يُنفَّذ** لأن Postgres متوقف على هذا الجهاز ولم تُشغَّل الواجهة البرمجية بناءً على تعليمات المهمة الصريحة بعدم محاولة تشغيل Docker/الـAPI.

---

## ٣. أشكال DTO للتدفقات الخمسة

### أ) عقد عميل (Customer Contract)
- **الإنشاء:** `POST /api/contracts` — `apps/api/src/modules/commercial/contracts.controller.ts:33-37` (`@Post()` بلا مسار فرعي؛ `@RequirePermissions(PERMISSIONS.CONTRACT_WRITE)`).
- **DTO:** `CreateContractDto` — `apps/api/src/modules/commercial/dto.ts:77-90`.
  الحقول:
  | الحقل | مطلوب؟ | النوع |
  |---|---|---|
  | `proposalRevisionId` | اختياري | `string` |
  | `customerId` | اختياري | `string` |
  | `contractType` | **مطلوب** | enum `CONTRACT_TYPES` |
  | `startDate` | اختياري | `string` (تاريخ) |
  | `endDate` | اختياري | `string` (تاريخ) |
  | `totalValue` | اختياري | `number ≥ 0` |
  | `retentionPct` | اختياري | `number ≥ 0` |
  | `advancePct` | اختياري | `number ≥ 0` |
  | `milestones` | اختياري | `MilestoneInputDto[]` |

  ملاحظة: لا `customerId` ولا `proposalRevisionId` مُعلَّمان `@IsNotEmpty`/إلزاميان معاً بمستوى الـDTO — المنطق الفعلي لأيّهما "يكفي" داخل `contracts.service.ts` (لم يُفحص بعمق لأن ذلك خارج نطاق T-00a).

  `MilestoneInputDto` (السطر 68-75 من نفس الملف):
  | الحقل | مطلوب؟ | النوع |
  |---|---|---|
  | `sequence` | **مطلوب** | `number` |
  | `descriptionAr` | **مطلوب** | `string` (≥1 حرف) |
  | `descriptionEn` | **مطلوب** | `string` (≥1 حرف) |
  | `triggerType` | اختياري | enum `MILESTONE_TRIGGER_TYPES` |
  | `amount` | **مطلوب** | `number ≥ 0` |
  | `dueDate` | اختياري | `string` |

### ب) طلب شراء (Purchase Requisition — PR)
- **الإنشاء:** `POST /api/requisitions` — `apps/api/src/modules/procurement/requisitions.controller.ts:50-54` (`@RequirePermissions(PERMISSIONS.REQUISITION_WRITE)`).
- **DTO:** `CreateRequisitionDto` — `apps/api/src/modules/procurement/requisitions.dto.ts:23-41`.
  | الحقل | مطلوب؟ | النوع |
  |---|---|---|
  | `justification` | **مطلوب** | `string` (3–1000 حرف) |
  | `departmentId` | اختياري | `string` |
  | `projectId` | اختياري | `string` |
  | `neededBy` | اختياري | تاريخ ISO |
  | `currency` | اختياري | `string` |
  | `lines` | **مطلوب** (مصفوفة غير فارغة) | `RequisitionLineDto[]` |

  `RequisitionLineDto` (السطر 15-21):
  | الحقل | مطلوب؟ | النوع |
  |---|---|---|
  | `itemId` | **مطلوب** | `string` |
  | `qty` | **مطلوب** | `number ≥ 0.001` (حتى 3 كسور عشرية) |
  | `estimatedUnitPrice` | اختياري | `number ≥ 0` |
  | `wbsElementId` | اختياري | `string` |
  | `notes` | اختياري | `string` (≤500 حرف) |

### ج) أمر شراء (Purchase Order — PO)
- **الإنشاء:** `POST /api/procurement/purchase-orders` — `apps/api/src/modules/procurement/procurement.controller.ts:49`.
- **DTO:** `CreatePoDto` — `apps/api/src/modules/procurement/dto.ts:42-48`.
  | الحقل | مطلوب؟ | النوع |
  |---|---|---|
  | `vendorId` | **مطلوب** | `string` |
  | `projectId` | اختياري | `string` |
  | `currency` | اختياري | `string` |
  | `lines` | **مطلوب** | `PoLineDto[]` |

  `PoLineDto` (السطر 35-40):
  | الحقل | مطلوب؟ | النوع |
  |---|---|---|
  | `itemId` | **مطلوب** | `string` |
  | `qty` | **مطلوب** | `number ≥ 0.001` |
  | `unitPrice` | **مطلوب** | `number ≥ 0` |
  | `wbsElementId` | اختياري | `string` |

  (أمر الشراء لا يُنشأ عادةً من الصفر وحده في تدفق الكوبايلوت المتوقع — بل غالباً عبر `POST /api/requisitions/:id/convert` بعد اعتماد الـPR، وهو مسار منفصل بـDTO مختلف: `ConvertToPoDto` في `requisitions.dto.ts:68-80` — `vendorId` مطلوب، `currency` وتسعير أسطر بديل `prices?: ConvertLinePriceDto[]` اختياريان.)

### د) محضر استلام (Goods Receipt — GRN)
- **الإنشاء (استلام على أمر شراء):** `POST /api/procurement/purchase-orders/:id/receive` — `apps/api/src/modules/procurement/procurement.controller.ts:68`.
- **DTO:** `ReceiveDto` — `apps/api/src/modules/procurement/dto.ts:59-65`.
  | الحقل | مطلوب؟ | النوع |
  |---|---|---|
  | `lines` | **مطلوب** | `ReceiveLineDto[]` |
  | `notes` | اختياري | `string` |
  | `locationId` | اختياري | `string` |

  `ReceiveLineDto` (السطر 51-57):
  | الحقل | مطلوب؟ | النوع |
  |---|---|---|
  | `poLineId` | **مطلوب** | `string` |
  | `qty` | **مطلوب** | `number ≥ 0.001` |
  | `serials` | اختياري (لكن يصبح فعلياً مطلوباً منطقياً للأصناف المُسلسلة — يُفحص في الخدمة لا الـDTO) | `string[]` |
  | `batchNo` | اختياري | `string` |

  بعد الإنشاء (`DRAFT`)، محضر الاستلام يمرّ بـ`/receipts/:id/inspect` ثم `/receipts/:id/accept` أو `/receipts/:id/reject` (procurement.controller.ts:76-104) — بلا أجسام إضافية غير `WorkflowActionDto`-مثيلة (لم تُفحص أجسامها التفصيلية لأنها خارج «إنشاء» التدفق المطلوب توثيقه).

### هـ) فاتورة مورّد (Vendor Bill)
- **الإنشاء:** `POST /api/procurement/bills` — `apps/api/src/modules/procurement/procurement.controller.ts:107`.
- **DTO:** `CreateBillDto` — `apps/api/src/modules/procurement/dto.ts:68-71`.
  | الحقل | مطلوب؟ | النوع |
  |---|---|---|
  | `goodsReceiptId` | **مطلوب** | `string` |
  | `vendorRef` | اختياري | `string` |

  ملاحظة مهمة للاستخراج من صورة/مستند: **لا حقول مبلغ أو سطور في `CreateBillDto` نفسها** — الفاتورة تُنشأ بالإشارة فقط إلى `goodsReceiptId`، وبقية القيم (المبلغ، الضريبة) تُشتق داخل `procurement.service.ts` من محضر الاستلام/أمر الشراء المرتبط (لم تُفحص تفاصيل الاشتقاق لأنها خارج نطاق DTO). هذا يتطابق مع دوسييه المشروع §14.2: «فاتورة مورد بلا سطور».

---

## ٤. هل `POST /api/contracts` يقبل المراحل (milestones) ضمن نفس الطلب؟

**نعم — ضمنياً، ولا توجد طريقة أخرى لإضافتها لاحقاً بنداء منفصل.**

- `CreateContractDto.milestones?: MilestoneInputDto[]` (`apps/api/src/modules/commercial/dto.ts:88-89`) حقل اختياري ضمن جسم إنشاء العقد نفسه.
- `contracts.service.ts:108-123` (مقتطف من القراءة الفعلية للسطور 105-123):
  ```ts
  milestones: dto.milestones
    ? { create: dto.milestones.map((m) => ({ ... })) }
    : undefined,
  ...
  include: { milestones: true },
  ```
  أي أن المراحل تُنشأ بعملية Prisma متداخلة (`create` نستد) **داخل نفس معاملة إنشاء العقد**.
- فُحص كامل `contracts.controller.ts` (55 سطراً) ولا يوجد أي مسار `POST /contracts/:id/milestones` أو ما شابه لإضافة مرحلة لاحقاً. المسارات الوحيدة بعد الإنشاء هي `:id/activate` و`:id/milestones/:milestoneId/verify` (توثيق مرحلة موجودة، لا إضافة واحدة جديدة).

**الأثر على الاستخراج (extract):** إذا استخرج الكوبايلوت مراحل من عقد ممسوح ضوئياً بعد أن أُنشئ العقد فعلاً بدونها، **لا يوجد نداء NPI لإضافتها** — يجب أن يضمّها الاستخراج والمعاينة **قبل** نداء الإنشاء، أو تبقى تلك المراحل غير قابلة للتسجيل عبر الكوبايلوت (فجوة تُسجَّل في `npiApiGapsJson` إذا احتاجها عميل يريد إضافة مرحلة لعقد قائم).

---

## ٥. عيب 14.1#1 — الترقيم يتوقف عند 1 يناير

**الحكم: مُثبَت (REPRODUCED) — بدليل ساكن (قراءة الشيفرة) ودليل ديناميكي (اختبار وحدة تجريبي شُغِّل ثم حُذف، كما يسمح به عقد المهمة).**

### آلية الفشل بالتحديد
- `apps/api/src/common/numbering.service.ts:19-20`:
  ```ts
  const client = tx ?? this.prisma;
  const fiscalYear = new Date().getUTCFullYear();
  ```
  السنة تُشتق من ساعة الخادم لحظة الاستدعاء، لا من إعداد أو ترحيل.
- `numbering.service.ts:24-40`: عملية `numberingSequence.update(...)` على المفتاح المركّب `(organizationId, documentType, fiscalYear)` — إن لم يوجد صف لهذه السنة تحديداً، تفشل Prisma (خطأ P2025 "record not found") ويُحوَّل الاستثناء إلى `InternalServerErrorException` (رمز 500) في السطرين 36-39.
- `packages/db/prisma/seed.ts:83`: `const fiscalYear = new Date().getUTCFullYear();` — تُحسَب مرة واحدة عند **تشغيل** سكربت البذرة.
- `packages/db/prisma/seed.ts:219-238`: حلقة `for (const s of seqDefs)` تعمل `upsert` لصفوف `numberingSequence` **لنفس تلك السنة فقط** (`fiscalYear` الثابتة أعلاه) — لا يوجد أي كود إنتاجي (ترحيل، مهمة مجدولة، أو منطق داخل `NumberingService`) يُنشئ صفاً تلقائياً للسنة الجديدة عند حلولها.

**النتيجة:** في أول طلب توليد رقم مستند (فاتورة، أمر شراء، طلب شراء… إلخ) بعد منتصف ليل 1 يناير بتوقيت UTC، تفشل `NumberingService.next()` بخطأ 500 لكل منشأة لم تُعَد بذرتها يدوياً، وتبقى كذلك حتى تدخّل يدوي (تشغيل البذرة من جديد أو إدراج صف SQL).

### هل «إعادة البدء من 1» تصطدم بالقيد الفريد؟
نعم، لكن ليس في جدول `NumberingSequence` نفسه (قيده الفريد `@@unique([organizationId, documentType, fiscalYear])` في `schema.prisma:310` يسمح بصف جديد لسنة جديدة بلا مشكلة) — **المشكلة في الجداول التجارية**:
- تنسيق الرمز الناتج (`numbering.service.ts:43`): `` `${updated.prefix}-${String(value).padStart(updated.padding, '0')}` `` **لا يتضمّن السنة إطلاقاً**.
- كل جدول مستند رئيسي في `schema.prisma` يفرض `@@unique([organizationId, code])` بلا أي مكوّن سنة — تحقّقتُ من ذلك في عشرات المواضع، من بينها: `Invoice` (نموذج يبدأ `schema.prisma:624`، القيد قريب من السطر 661)، `PurchaseOrder` (نموذج ~945-978، القيد `schema.prisma:976`)، `GoodsReceipt` (نموذج ~1000-1027، القيد `schema.prisma:1026`)، `VendorBill` (نموذج يبدأ `schema.prisma:1668`، القيد قريب من `schema.prisma:1690`)، وغيرها.
- لو أُعيدت تهيئة صف تسلسل 2027 بـ`nextValue` يبدأ من 1، فإن أول فاتورة في 2027 ستولّد الرمز **نفسه حرفياً** (مثلاً `INV-00001`) الذي تحمله فعلاً فاتورة 2026 الأولى في نفس المنشأة — فيصطدم إدراج السجل التجاري الجديد بقيد `@@unique([organizationId, code])` بخطأ Prisma P2002 (انتهاك قيد فريد)، وليس بقيد `NumberingSequence`.

### دليل ديناميكي
كُتب اختبار وحدة تجريبي (jest، بلا حاجة لقاعدة بيانات — يُحاكي رفض Prisma لمفتاح غير موجود) في `apps/api/src/common/_probe-numbering-year.spec.ts`، شُغِّل بأمر:
```
npx jest --config apps/api/jest.config.js apps/api/src/common/_probe-numbering-year.spec.ts
```
النتيجة الفعلية: **PASS — 2/2 اختبارين** (يؤكدان: (أ) رفض Prisma لصف سنة غير موجود يتحوّل إلى `InternalServerErrorException`، و(ب) أن الرمز الناتج من `nextValue=1` مطابق حرفياً بين سنتين لأن التنسيق لا يتضمن السنة). **حُذف الملف بعد التحقق** (`git status` بعد الحذف نظيف) — الاختبار الحقيقي دائم البقاء هو من مسؤولية T-00b.

**غير متحقق ديناميكياً:** تشغيل هذا السيناريو فعلياً ضد Postgres حية (تغيير ساعة النظام أو حقن صف بسنة مقبلة ثم استدعاء `/api/requisitions` الحقيقي) — لم يُنفَّذ لأن Postgres متوقف؛ هذا بالضبط ما تغطيه `npm run test:int -- concurrency` وسيناريو الاختبار الحقيقي في T-00b.

---

## ٦. عيب 14.1#2 — اعتماد طلب الشراء يتجاوز مصفوفة الاعتماد

**الحكم: مُثبَت (REPRODUCED) — بدليل ساكن ودليل ديناميكي (اختبار وحدة تجريبي شُغِّل ثم حُذف).**

### مسار الاستدعاء بالتفصيل
- `apps/api/src/modules/procurement/requisitions.controller.ts:73-81`: نقطة الدخول الوحيدة للإجراءات هي `POST /requisitions/:id/actions`، محمية فقط بصلاحية القاعدة `PERMISSIONS.REQUISITION_WRITE` — والتعليق فوقها (السطر 66-72) يوضّح صراحة أن هذه صلاحية عامة، والقرار الفعلي متروك للمحرّك.
- `requisitions.service.ts:258-278` — `act()`:
  ```ts
  async act(user: AuthUser, id: string, action: string, comment?: string) {
    const pr = await this.owned(user, id);
    if (action === WF_ACTIONS.SUBMIT) return this.submit(user, pr, comment);
    const result = await this.engine.transition(user, {
      documentType: 'PurchaseRequisition',
      documentId: pr.id,
      actionCode: action,
      ...
    });
    return { ...result, status: result.toState };
  }
  ```
  **فقط** إجراء `SUBMIT` يُوجَّه إلى `this.submit(...)` الذي يستشير مصفوفة الاعتماد (`this.approvals.gate(...)`, السطر 294 وما بعده). أي إجراء آخر — بما فيه `APPROVE` — يذهب مباشرة إلى `this.engine.transition(...)` **بلا أي استدعاء لـ`approvals.gate`**.
- `apps/api/src/common/workflow/workflow.engine.ts:245-322` — الدالة الخاصة `plan()` (المستدعاة من كل من `transition()` و`assertCan()`) تتحقق فقط من:
  1. وجود انتقال قانوني في `wf_transitions` لهذه الحالة (`plan():266-282`).
  2. أن صلاحيات المستخدم الثابتة تتضمن `transition.requiredPermission` (`plan():284-288`) — فحص دور/صلاحية عامة، **وليس** فحصاً لكون المستخدم هو صاحب الدور المعيَّن حالياً (`wfInstance.assigneeRoleId`) ولا لكونه الخطوة الحالية في سلسلة توقيع مصفوفة الاعتماد.
  3. شرط نصي اختياري (`conditionExpr`) لا علاقة له بمصفوفة الاعتماد.
  في أي مكان من `plan()` **لا يوجد** استدعاء لخدمة الاعتماد (`ApprovalService`) ولا مقارنة بين `user.userId` وصاحب الطلب الأصلي.
- `packages/db/prisma/seed.ts:632`: تعريف انتقال `APPROVE` لتدفق `PurchaseRequisition`:
  ```
  { from: 'PENDING_APPROVAL', to: 'APPROVED', action: 'APPROVE', ..., permission: 'scm.procurement.write', emits: 'pr.approved' }
  ```
  الصلاحية المطلوبة هي `scm.procurement.write` فقط — صلاحية دور عريضة (يحملها أي عضو فريق مشتريات نمطي)، **وليست** خطوة موقّعة في مصفوفة الاعتماد لهذا المبلغ/القسم بعينه.

### مَن يستطيع الاعتماد رغم أنه لا ينبغي له؟
1. **أي مستخدم يحمل `scm.procurement.write`** — بصرف النظر عمّا إذا كانت مصفوفة الاعتماد (`ApprovalRequest.currentStep`) تُعيّنه فعلياً كالموقّع الحالي على هذا الطلب بعينه، أم أن السلسلة لا تزال بانتظار توقيع شخص آخر في خطوة سابقة. الطلب يبقى فعلياً `PENDING` في جدول مصفوفة الاعتماد بينما حالته في محرك الوورك فلو تتحول إلى `APPROVED` — وهو بالضبط ما وصفه `docs/PROJECT_DOSSIER_AR.md §9.5 بند 1`.
2. **مقدّم الطلب نفسه**، إن كان يحمل تلك الصلاحية (سيناريو واقعي حسب دوسييه المشروع §10.2 بند 8: «المحاسب يعتمد الـPO ويعتمد الفاتورة ويسددها» — نفس نمط تركّز الصلاحيات) — لا يوجد أي فحص في `act()` أو `owned()` يقارن `user.userId` بمنشئ الطلب قبل تنفيذ `APPROVE`.

### دليل ديناميكي
اختبار وحدة تجريبي (jest، بمحاكاة `prisma`/`engine`/`approvals` — بلا حاجة لقاعدة بيانات) في `apps/api/src/modules/procurement/_probe-approve-bypass.spec.ts`، شُغِّل بأمر:
```
npx jest --config apps/api/jest.config.js apps/api/src/modules/procurement/_probe-approve-bypass.spec.ts
```
النتيجة الفعلية: **PASS — 2/2 اختبارين**:
1. مستخدم يحمل `scm.procurement.write` فقط (ليس بالضرورة الخطوة الحالية في المصفوفة) نفّذ `act(user, prId, 'APPROVE')` بنجاح، والحالة تحولت إلى `APPROVED`، بينما `approvals.gate` **لم يُستدعَ ولو مرة واحدة**.
2. نفس السيناريو مع `user.userId === pr.createdById` (مقدّم الطلب نفسه) أعطى نفس النتيجة تماماً — لا حجب.

**حُذف الملف بعد التحقق** (`git status` بعد الحذف نظيف). الاختبار الدائم (`pr-approval-bypass.int-spec.ts`) والإصلاح من مسؤولية T-00c.

**غير متحقق ديناميكياً:** سيناريو تكامل حقيقي (`npm run test:int -- pr-approval-bypass`) ضد Postgres حية بمستخدمين وأدوار فعليين من البذرة — لم يُنفَّذ لأن Postgres متوقف؛ هذا بالضبط ما يغطيه G-0-3.

---

## ٧. سياسة استخدام بيانات المزوّد (Anthropic)

تم جلب الصفحة التالية فعلياً عبر أداة الجلب في هذه الجلسة بتاريخ **2026-09-21**:

**المصدر:** [`https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training`](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) — «Is my data used for model training?» (توثيق الخصوصية الرسمي لـAnthropic، قسم المنتجات التجارية).

**الاقتباس الحرفي (الافتراضي):**
> "By default, we will not use your inputs or outputs from our commercial products (e.g. Claude for Work, Anthropic API, Claude Gov, etc.) to train our models."

**الاقتباس الحرفي (شرط الاستثناء الوحيد):**
> "If you explicitly report feedback or bugs to us (e.g. via our thumbs up/down feedback button), or otherwise choose to allow us to use your data, then we may use your chats and coding sessions to train our models."

مصدر مساند (توثيق منصة Claude التقني، نفس اليوم): [`https://platform.claude.com/docs/en/manage-claude/api-and-data-retention`](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) يذكر أيضاً:
> "Retained data is never used for model training without your express permission."

**الخلاصة لبطاقة الموافقة (`ConsentCard`) في `02-TECH-SPEC.md §5`:** واجهة Anthropic API التجارية (وهي ما سيستخدمه الكوبايلوت عبر `@anthropic-ai/sdk`) **لا** تُستخدم مدخلاتها/مخرجاتها لتدريب النماذج افتراضياً، ولا استثناء إلا بإرسال المستخدم التغذية الراجعة صراحةً عبر أزرار الإعجاب/عدم الإعجاب — وهو مسار لا يستخدمه الكوبايلوت. هذا البند الآن **مؤكد** (لم يعد «غير متحقق» كما ورد في `02-TECH-SPEC.md §0/§1`).

---

## ٨. حالة بوابات الاختبار

القيم التالية **نُفِّذت من قِبل المُشغِّل (orchestrator) على هذه الشجرة قبل بدء T-00a**، وأنا هنا أسجّلها كما وردت دون إعادة تشغيلها بنفسي (التزاماً بقاعدة النزاهة: لا أدّعي تشغيل ما لم أُشغّله):

| البوابة | النتيجة المصرَّح بها | حالتها هنا |
|---|---|---|
| `npm run typecheck` | PASS — كل الحزم الأربع (`@npi/db`, `@npi/shared`, `apps/api`, `apps/web`) | كما ورد من المُشغِّل |
| `npm run lint` | PASS — eslint نظيف | كما ورد من المُشغِّل |
| `npm test` | PASS — 20 حزمة / 187 اختباراً | كما ورد من المُشغِّل (يطابق `docs/PROJECT_DOSSIER_AR.md §11.1`: "20 حزمة · 187 اختباراً") |
| `npm run test:int` | **غير متحقق** | Postgres متوقف (Docker Desktop متوقف على هذا الجهاز) — لم يُنفَّذ إطلاقاً، لا من المُشغِّل ولا من هذه المهمة |

**ما نفّذتُه أنا فعلياً في هذه الجلسة (ولا علاقة له بإعادة تشغيل `npm test` الكاملة):** أمرا `npx jest` محدودان بملفين تجريبيين (`_probe-numbering-year.spec.ts` و`_probe-approve-bypass.spec.ts`)، وُثِّقا في القسمين ٥ و٦ أعلاه، ثم حُذفا. لم أُشغِّل `npm test` الكاملة ولا `npm run test:int` ولا `npm run typecheck`/`lint` بنفسي في هذه المهمة.

---

## ما لم يُتحقق منه

هذا القسم يُقرأ عند خطوة 0.2 من UAT (`spec/madar/09-OWNER-UAT.md`) — كل بند بدقة وبما يلزم لإغلاقه:

1. **تشغيل فعلي لـ`/api/docs-json`.**
   الحالة: تحليل ساكن فقط (main.ts:44-56)، يُرجَّح أن يعمل، لكن لم يُختبر بطلب HTTP حقيقي.
   المطلوب لإغلاقه: تشغيل Postgres (`npm run docker:up`)، تشغيل الـAPI (`npm run dev` حسب `.claude/launch.json`)، ثم `curl -s http://localhost:4000/api/docs-json | head -c 200` والتأكد من استجابة JSON صحيحة (200 و`Content-Type: application/json`).

2. **`npm run test:int` (يشمل `-- concurrency` و`-- pr-approval-bypass`).**
   الحالة: لم يُنفَّذ إطلاقاً على هذه الشجرة، لا قبل T-00a ولا خلالها — Docker Desktop متوقف.
   المطلوب لإغلاقه: تشغيل Docker Desktop، `npm run docker:up`، ثم `npm run test:int` كاملة، وتسجيل عدد الحزم/الاختبارات الفعلي.

3. **الإثبات الديناميكي الكامل (تكاملي) لعيب الترقيم (14.1#1) وعيب تجاوز مصفوفة الاعتماد (14.1#2) ضد قاعدة بيانات حية ببيانات بذرة حقيقية.**
   الحالة: مُثبَتان حالياً بقراءة الشيفرة + اختباري وحدة تجريبيين بمحاكاة (mocks) لا بقاعدة حقيقية.
   المطلوب لإغلاقه: هذا هو نطاق T-00b وT-00c مباشرة — اختبار انحدار دائم لكل منهما يفشل قبل الإصلاح وينجح بعده، مع `npm run test:int` كاملة خضراء.

4. **مصير فاتورة المورد ومحضر الاستلام بعد أول نداء `create`.**
   الحالة: وُثِّقت أشكال DTO للإنشاء فقط (القسم ٣). خطوات ما بعد الإنشاء (`inspect/accept/reject/match/schedule`) لم تُفحص أجسامها بالتفصيل لأنها خارج طلب «شكل الإنشاء».
   المطلوب لإغلاقه (إن احتاجه M3 لاحقاً): قراءة بقية `procurement.controller.ts`/`procurement.service.ts` عند بناء `src/execute/flows/{grn,vendor_bill}.ts` في T-27.

5. **نسخة Sonnet/Haiku والتسعير الدقيق المذكوران في `02-TECH-SPEC.md §1` (خارج نطاق T-00a صراحة، لكن للأمانة):** لم يُعاد التحقق منهما هنا — هذا البند لم يكن ضمن قائمة «غير متحقق» في §0/§1 الموكلة لـT-00a تحديداً (الجدول هناك يُصنّفهما "Likely"/"Confirmed" بتاريخ سابق)، وتُرك كما هو.

---

## ملاحظة إجرائية (قاعدة النزاهة، `08-CLAUDE-CODE-KICKOFF.md §E.9`)

لم يُدَّعَ اجتياز أي اختبار لم يُنفَّذ فعلياً في هذه الجلسة أو من قِبل المُشغِّل كما هو مُصرَّح به أعلاه. اختباران تجريبيان (probe) كُتبا لإثبات آلية العيبين 14.1#1 و14.1#2 ديناميكياً دون الحاجة لقاعدة بيانات حية، ثم **حُذفا فوراً بعد التحقق** ولم يدخلا الالتزام (commit) — تم التأكد بـ`git status` أن الشجرة نظيفة بعد الحذف. لم يُعدَّل أي ملف آخر غير هذا التقرير.
