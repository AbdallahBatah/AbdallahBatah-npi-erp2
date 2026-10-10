# الخطوة 3 — الفرص وقمع المبيعات: تقرير الوكيل المنفّذ

> الحالة: كل شيء في شجرة العمل غير ملتزَم (لا commit). مجلد العمل `C:\dev\npi-erp-crm` على `feature/crm-phase-1` (HEAD 7eef4e0). القاعدة المحلية كانت متاحة طوال الجلسة.

## 1. ملخص التنفيذ

نُفِّذ العقد بأقسامه 1–8 كاملة: اختبارات أولاً (وحدة + تكامل) وسُجِّل فشلها لأسباب متوقعة (واجهات غير موجودة)، ثم الترحيل `0024_crm_opportunities` (مرحلة `QUALIFICATION`، نوع الفرصة `DIRECT/TENDER`، حقول المناقصة والضمان الابتدائي، جدول `LossReason`، أعمدة `lossReasonId/lossNotes/closedAt/stageChangedAt`، و`AttachmentEntity.OPPORTUNITY`) مع `down.sql` يدوي. في المشترك: قواعد الانتقال النقية (`opportunityTransition`) وأحداث `opportunity.won/lost`. في الـAPI: `POST /opportunities/:id/stage` بحماية تفاؤلية (`updateMany ... where stage = old` + `count === 1`)، وإنشاء/تعديل ذرّي مع قاعدة المناقصة وتصفير حقولها عند التحويل إلى مباشرة وقفل الفرصة المقفلة، ومسارا العرض (ينقل إلى `PROPOSAL`) والعقد (`WON` عبر قاعدة موحّدة ترفض الخاسرة)، و`/loss-reasons` بلا حذف، والمرفقات والبحث. في الواجهة: قائمة محسّنة، صفحة `/opportunities/[id]` بشريط المراحل وبطاقة المناقصة والتبويبات، تبويب «أسباب الخسارة» في الإدارة، وروابط من صفحة العميل. البذرة تزرع الأسباب الستة. كل البوابات خضراء بعد دورة `down.sql` وإعادة الترحيل: jest 334 (كان 270)، test:int 79 (كان 52)، typecheck وlint نظيفان، وبناء Next ينجح.

## 2. الملفات

### db
- `packages/db/prisma/migrations/0024_crm_opportunities/migration.sql` (جديد): enum `OpportunityType`، `ADD VALUE IF NOT EXISTS` لـ`QUALIFICATION` (بعد `PROSPECTING`) و`OPPORTUNITY`، جدول `LossReason` (تفرّد `(organizationId,nameAr)` وفهرس `(organizationId,isActive,sortOrder)`)، 11 عمود على `Opportunity`، فهرسان، مفتاحان أجنبيان (`Restrict` لسبب الخسارة). لا استعمال لقيمة enum جديدة داخل الملف.
- `packages/db/prisma/migrations/0024_crm_opportunities/down.sql` (جديد): يفشل عمداً إن وُجدت فرصة بمرحلة `QUALIFICATION` (موثّق في الرأس مع أمر التصحيح)، يحذف مرفقات `OPPORTUNITY`، الأعمدة، الفهارس، `LossReason`، `OpportunityType`؛ وتعليق أن `QUALIFICATION` و`OPPORTUNITY` تبقيان في enum.
- `packages/db/prisma/schema.prisma`: enum/نموذج/أعمدة/علاقات الترحيل (وعلاقة `lossReasons` على `Organization`).
- `packages/db/prisma/seed.ts`: ستة أسباب خسارة لكل منشأة مزروعة (upsert بـ`update: {}` فلا يُكتب فوق تعديل المسؤول).

### shared
- `packages/shared/src/opportunity-stages.ts` (جديد): `OPPORTUNITY_STAGE_FLOW`، `OPPORTUNITY_TERMINAL`، `isOpenStage`، `opportunityTransition`، `isBackwardMove`.
- `packages/shared/src/enums.ts`: `OPPORTUNITY_STAGES` بالترتيب الجديد والعناوين العربية الرسمية (محتمل، تأهيل، عرض سعر، تفاوض، رابحة، خاسرة)، و`OPPORTUNITY_TYPES`.
- `packages/shared/src/workflow.ts`: `OPPORTUNITY_WON/LOST` + عناوينهما.
- `packages/shared/src/index.ts`: تصدير الملف الجديد.

### api
- `apps/api/src/modules/crm/opportunities.service.ts` (أعيدت كتابته): `list(filters)`، `get` (+owner/lossReason/contracts)، `create` (دائماً `PROSPECTING`)، `update` داخل معاملة وتدقيق ذرّي، `changeStage`، `advanceOnProposal`، `markWonViaContract`، ودالة داخلية واحدة `applyStageChange` هي المكان الوحيد الذي تُكتب فيه المرحلة.
- `apps/api/src/modules/crm/opportunities.controller.ts`: `GET ?stage&type&open`، `POST :id/stage`.
- `apps/api/src/modules/crm/loss-reasons.service.ts` و`loss-reasons.controller.ts` (جديدان): `GET /loss-reasons[?all=1]` (`crm.opportunity.read`)، `POST` و`PATCH :id` (`admin.org.manage`)، بلا حذف.
- `apps/api/src/modules/crm/dto.ts`: DTOs الفرصة (بلا `stage` في الإنشاء؛ `stage` مُعلن في التعديل فقط ليُرفض برسالة واضحة)، `ChangeStageDto`، DTOs أسباب الخسارة، و`ConvertLeadDto.opportunityType/tenderCloseDate`.
- `apps/api/src/modules/crm/crm.module.ts`: تسجيل الخدمة والمتحكم الجديدين.
- `apps/api/src/modules/crm/leads.service.ts`: `convert` يمرّر النوع (افتراضي `DIRECT`) ويضع `stageChangedAt`.
- `apps/api/src/modules/crm/customers.service.ts`: `opportunityType` في تبويب الفرص بنظرة العميل.
- `apps/api/src/modules/commercial/proposals.service.ts`: `create` ينقل الفرصة عبر `advanceOnProposal` داخل معاملة العرض (409 للمقفلة).
- `apps/api/src/modules/commercial/contracts.service.ts`: استبدال `opportunity.update({stage:'WON'})` الصامت بـ`markWonViaContract` في أول المعاملة (قبل الترقيم وقبل إنشاء العقد).
- `apps/api/src/modules/commercial/commercial.module.ts`: `imports: [CrmModule]`.
- `apps/api/src/modules/platform/attachments.service.ts`: `OPPORTUNITY` في خريطة الصلاحيات و`assertEntityExists`.
- `apps/api/src/modules/search/search.service.ts`: مجموعة `opportunities` (الاسم/الرمز/`tenderReference`) و`href` = `/opportunities/{id}`.
- `apps/api/src/modules/reference/reference.controller.ts`: `opportunityTypes` في `/reference/enums`، ولوحة القيادة تستعمل `OPPORTUNITY_STAGE_FLOW` بدل `notIn [WON,LOST]` الحرفي.

### web
- `apps/web/src/app/(app)/opportunities/page.tsx`: صفوف تنقل إلى التفاصيل؛ أعمدة النوع وعمر المرحلة وتاريخ الإقفال المتوقع؛ فلتر النوع؛ نافذة الإنشاء بالنوع والتاريخ وحقول المناقصة تظهر عند اختيار «مناقصة» فقط؛ «إنشاء عرض» يختفي للمقفلة.
- `apps/web/src/app/(app)/opportunities/[id]/page.tsx` (جديد): الترويسة، شريط المراحل، أزرار التالي/الرجوع/خاسرة/رابحة، شريط الفرصة المقفلة، بطاقة المناقصة (تحذير أحمر إن مضى الموعد أو بقي أقل من 7 أيام)، نافذة الخسارة (سبب إلزامي + ملاحظات)، نافذة التعديل، تبويبات العروض/العقود/المرفقات.
- `apps/web/src/components/opportunity-bits.tsx` (جديد): شارة النوع و`daysSince/daysUntil`.
- `apps/web/src/components/loss-reasons.tsx` (جديد): بطاقة إدارة الأسباب (إنشاء/تعديل/تعطيل/تفعيل، بلا حذف).
- `apps/web/src/app/(app)/admin/page.tsx`: تبويب `lossReasons` لمن يحمل `admin.org.manage`.
- `apps/web/src/app/(app)/customers/[id]/page.tsx`: صفوف الفرص روابط + عمود النوع.
- `apps/web/src/components/ui.tsx`: `QUALIFICATION` وتصحيح «محتمل/رابحة».
- `apps/web/src/components/attachments.tsx`: اتحاد الأنواع يشمل `OPPORTUNITY`.
- `apps/web/src/components/global-search.tsx`: مجموعة `opportunities` في البحث الشامل.
- `apps/web/src/components/audit-log.tsx`: عنوان كيان `LossReason`.
- `apps/web/src/lib/useEnums.ts`: `opportunityTypes`.
- `apps/web/src/lib/errors.ts`: أنماط `Invalid stage transition` (مترجمة حسب `reason` من جسم الاستجابة: TERMINAL/SKIP/CONCURRENT)، `Loss reason is required`، `Tender close date is required`، `Opportunity is closed`، `Stage changes go through`، `Loss reason name already in use`، `must be a valid date`.
- `apps/web/src/lib/messages.ts`: مفاتيح `opps.*` و`adm.tab.lossReasons` و`lossReasons.*` بالعربية والإنجليزية.

### tests
- `apps/api/src/common/opportunity-stages.spec.ts` (جديد، 18): جدول الانتقالات كاملاً + المفردات والأحداث.
- `apps/api/src/modules/crm/opportunities.service.spec.ts` (جديد، 31).
- `apps/api/src/modules/crm/loss-reasons.service.spec.ts` (جديد، 11).
- `apps/api/src/modules/commercial/proposals.service.spec.ts` (جديد، 2).
- `apps/api/src/modules/commercial/contracts.service.spec.ts` (7، كان 5): يمرّ عبر `OpportunitiesService` الحقيقي؛ عقد على خاسرة → 409 بلا إنشاء؛ عقد ثانٍ على رابحة مسموح.
- `apps/api/src/modules/commercial/revision-pricing.spec.ts`: وسيط رابع لبناء `ProposalsService` فقط.
- `apps/api/test/opportunity-stages.int-spec.ts` (جديد، 20).
- `apps/api/test/tenant-isolation.int-spec.ts` (+7) و`accounting-reconciliation.int-spec.ts`: بناء الخدمات بالوسطاء الجديدة.

### seed
- `packages/db/prisma/seed.ts` (أعلاه). `scripts/seed-demo.js` لم يُعدَّل (انظر القسم 6).

## 3. البوابات

كلها من جذر المستودع بعد دورة `down.sql` وإعادة الترحيل (آخر تشغيل):

| الأمر | النتيجة |
|---|---|
| `npm run typecheck` | db / shared / api / web: `tsc --noEmit` بلا أخطاء |
| `npm run lint` | `eslint .` بلا مخرجات (نظيف) |
| `npm test` | `Test Suites: 32 passed, 32 total` / `Tests: 334 passed, 334 total` (الأساس 270، +64) |
| `npm run db:deploy` | `24 migrations found in prisma/migrations` / `No pending migrations to apply.` (طُبِّق 0024 أول مرة ثم أعيد تطبيقه بعد الدورة: `Applying migration 0024_crm_opportunities` / `All migrations have been successfully applied.`) |
| `npm run db:seed` | `✅ Seed complete.` (ست أسباب في المنشأة؛ إعادة التشغيل idempotent) |
| `npm run test:int` | `Test Suites: 6 passed, 6 total` / `Tests: 79 passed, 79 total` (الأساس 52، +27) |
| `npm run build -w @npi/web` | `✓ Compiled successfully`؛ المسارات `/opportunities` و`/opportunities/[id]` و`/admin` مبنية |

**دورة `down.sql` (قاعدة محلية):**
1. تشغيل `down.sql` وفي القاعدة فرصة بمرحلة `QUALIFICATION` (من تجربة API الدخانية): `Error: ERROR: Rollback of 0024 refused: opportunities still sit at QUALIFICATION. Move them to PROSPECTING first` — ولم يتغير شيء (الجدول والأعمدة بقيت).
2. تحريك تلك الفرصة إلى `PROSPECTING` ثم إعادة التشغيل: `Script executed successfully.`. فحص الكتالوج بعدها: لا جدول `LossReason`، لا عمود `closedAt`، لا نوع `OpportunityType`، و**`OpportunityStage` = [PROSPECTING, QUALIFICATION, PROPOSAL, NEGOTIATION, WON, LOST]** و**`AttachmentEntity` = [CONTRACT, INVOICE, PROJECT, WORK_ORDER, CUSTOMER, OPPORTUNITY]** — أي `QUALIFICATION` و`OPPORTUNITY` بقيتا في الـenum كما هو موثّق.
3. `npx prisma migrate resolve --rolled-back 0024_crm_opportunities` رُفض بـ`P3012 ... cannot be rolled back because it is not in a failed state` (الترحيل مسجَّل «منتهياً» لا «فاشلاً»)، فاتُّبعت خطوة رأس `down.sql`: `DELETE FROM "_prisma_migrations" WHERE migration_name = '0024_crm_opportunities'` ثم `npm run db:deploy` فطُبِّق الترحيل من جديد (القيمتان موجودتان فمرّ `IF NOT EXISTS`)، و`db:seed` أعاد الأسباب الستة (فحص: 6 صفوف).
4. بعد الدورة أُعيدت البوابات كاملة (الجدول أعلاه).

كما فُحص `prisma migrate diff` بين القاعدة وملف المخطط: لا فروق تخص `Opportunity`/`LossReason`/`Attachment` (توجد فروق قديمة لا علاقة لها بهذه الخطوة في `ApprovalRule`/`GoodsReceiptLine`، لم تُلمس).

**تجربة API دخانية** (نسخة مبنية من `dist` على المنفذ 4010، أُوقفت بعدها): الإقلاع سليم (حقن الاعتماديات بين `CommercialModule` و`CrmModule` يعمل)؛ `GET /loss-reasons` ← 6؛ `POST /opportunities` بـ`stage` ← 400 `property stage should not exist`؛ مناقصة بلا تاريخ ← 400 `Tender close date is required`؛ `PATCH` بـ`stage` ← 400 `Stage changes go through /stage`؛ `PROSPECTING→PROPOSAL` ← 409 `{code:'OPPORTUNITY_STAGE', reason:'SKIP'}`؛ `LOST` بلا سبب ← 400؛ `→QUALIFICATION` نجح مع `stageChangedAt`؛ `?type=TENDER&open=1` يعمل؛ `/search?q=smoke` يعيد المجموعة `opportunities` بـ`href=/opportunities/{id}`؛ `/attachments/OPPORTUNITY/{id}` ← `[]`.

## 4. الأدلة قبل/بعد

**قبل (قبل أي كود):** `npm test -- opportunity-stages opportunities.service loss-reasons contracts.service proposals.service` ← `Test Suites: 5 failed, 5 total / Tests: 0 total`، كلها أخطاء تجميع `ts-jest` متوقعة:
- `opportunity-stages.spec.ts` (10 أخطاء): `'"@npi/shared"' has no exported member named 'OPPORTUNITY_STAGE_FLOW'` / `has no exported member 'OPPORTUNITY_TERMINAL'`.
- `opportunities.service.spec.ts` (25 خطأ): `Expected 3 arguments, but got 4` / `Property 'changeStage' does not exist on type 'OpportunitiesService'` / `'opportunityType' does not exist in type 'CreateOpportunityDto'` / `Property 'markWonViaContract' does not exist`.
- `loss-reasons.service.spec.ts` (2): `Cannot find module './loss-reasons.service'`.
- `proposals.service.spec.ts` (1): `Expected 3 arguments, but got 4`.
- `contracts.service.spec.ts` (2): `Expected 4 arguments, but got 5`.
- التكامل: `npm run test:int -- opportunity-stages` ← `FAIL test/opportunity-stages.int-spec.ts`، 39 خطأ تجميع (`Cannot find module '../src/modules/crm/loss-reasons.service'`، `Property 'changeStage' does not exist`، ...).

**بعد:**
- `opportunity-stages.spec.ts`: 18 passed. `opportunities.service.spec.ts`: 31 passed. `loss-reasons.service.spec.ts`: 11 passed. `proposals.service.spec.ts`: 2 passed. `contracts.service.spec.ts`: 7 passed.
- `opportunity-stages.int-spec.ts`: `Tests: 20 passed, 20 total` (شُغِّل أربع مرات متتالية بنفس النتيجة، منها اختباري التزامن). يغطي: القمع كاملاً `PROSPECTING→QUALIFICATION→(عرض يُحرّك إلى PROPOSAL مع `via: proposal`)→NEGOTIATION→(رجوع `backward: true`)→LOST` مع `closedAt` وحدث `opportunity.lost` ورفض عرض وعقد جديدين بـ409؛ فرصة ثانية: عقد من `PROPOSAL` يكسبها `WON` (`via: contract`) مع حدث `opportunity.won` ثم `/stage` ← 409 `TERMINAL`؛ التزامن: طلبان متوازيان `QUALIFICATION→PROPOSAL` ينجح أحدهما فقط وصف تدقيق واحد، وسباق عقد/خسارة ينتهي بنتيجة واحدة وحدث واحد؛ المناقصة وتصفير حقولها؛ فلاتر القائمة؛ قائمة الأسباب (المعطَّل مخفي عن المندوب مرئي للمسؤول، تكرار الاسم 409، وقيد `Restrict` يمنع الحذف على مستوى القاعدة).
- `tenant-isolation.int-spec.ts`: +7 اختبارات (فرصة/مرحلة/تعديل/سبب خسارة لمنشأة أخرى → 404، فرصة تخص المهاجم نفسه بسبب خسارة من منشأة أخرى → 404 ولا تتغير، رفع مرفق على فرصة غيري → 404، القوائم لا تسرّب).

## 5. الانحرافات عن العقد

1. **موضع اختبار المشترك:** `apps/api/src/common/opportunity-stages.spec.ts` بدل `packages/shared/src/opportunity-stages.spec.ts`، لأن `packages/shared` بلا إعداد jest و`npm test` يجذر عند `apps/api/src` (نفس ترتيب `arabic.spec.ts` من الخطوة 2).
2. **`opportunityTransition`:** يعيد `{ok:true}` حرفياً؛ الوسم `backward` في دالة مستقلة `isBackwardMove(from,to)` بدل حشوه في النتيجة. والانتقال إلى المرحلة نفسها يُرفض بـ`SKIP` (لا سبب رابع في العقد؛ ضروري ليخسر الطلب المتزامن الثاني).
3. **توقيع المساريْن النظاميين:** دالتان على `OpportunitiesService` لا دالتان حرّتان: `markWonViaContract(tx, user, opportunityId)` و`advanceOnProposal(tx, user, opportunityId)`. تقرآن الصف داخل المعاملة نفسها وتكتبان بشرط المرحلة المقروءة، ولذلك تُحقن `OpportunitiesService` في `ContractsService` (وسيط خامس) و`ProposalsService` (وسيط رابع) ويستورد `CommercialModule` الوحدة `CrmModule`. تُحدِّث هذه الإضافة بناء الخدمتين في اختبارات الوحدة والتكامل (حُدِّثت).
4. **تناقض داخل العقد وحلّه:** القسم 3 يقول «عقد ثانٍ على فرصة رابحة لا يُرفض»، بينما القرار 10-3 يقول «المقفلة ترفض عروضاً وعقوداً جديدة». اتُّبع القسم 3 المفصّل: **العرض** يُرفض على `WON` و`LOST`؛ **العقد** يُرفض على `LOST` فقط ويمرّ على `WON` بلا تغيير. إن أردتَ رفضه على `WON` أيضاً فهو سطر واحد في `markWonViaContract`.
5. **ترتيب `markWonViaContract`:** في بداية معاملة العقد (قبل الترقيم وقبل `contract.create`) فيُرفض العقد على الخاسرة دون كتابة أي شيء، بدل موضع `update` القديم بعد إنشاء العقد.
6. **التحويل من عميل محتمل:** أضيف `tenderCloseDate` إلى `ConvertLeadDto`، ويُرفض `opportunityType: 'TENDER'` بدونه (400 `Tender close date is required`) حفاظاً على الثابت «المناقصة لها تاريخ إقفال دائماً». العقد قال «يمرّر النوع فقط».
7. **البحث:** الفرص لم تكن تُبحث أصلاً (لم يوجد `href` قديم يُصحَّح)؛ أُضيفت مجموعة `opportunities` كاملة في الخدمة، وفي `global-search.tsx` لتظهر في الواجهة.
8. **`stageChangedAt`:** يُوضع أيضاً عند إنشاء الفرصة وعند التحويل من عميل محتمل (العقد لم يذكره)، ليكون «عمر المرحلة» صحيحاً؛ الفرص القديمة تبقى `null` والواجهة تعود لـ`createdAt`.
9. **التحقق في الواجهة:** تاريخ إقفال المناقصة وسبب الخسارة بلا `required` الأصلي (فقاعة المتصفح بلا عربية)؛ بدلاً منها فحص عميل يعرض نفس الجملة العربية من `errors.ts` تحت الحقل، والخادم يفرض القاعدة أيضاً.
10. **حقل `stage` في إنشاء الفرصة:** حُذف من DTO فيصير إرساله 400 برسالة الـpipe العامة (`property stage should not exist`) لا برسالة `/stage`؛ الرسالة المخصّصة لـ`PATCH` فقط (حيث أُبقي الحقل معلناً في DTO لهذا الغرض).
11. **تعديل المقفلة:** `lossNotes` يُكتب فقط إن كانت الفرصة `LOST` (على `WON` يُتجاهل).
12. **إضافة خارج القائمة:** عنوان `LossReason` في سجل التدقيق (`audit-log.tsx`) وعمود النوع في صفحة العميل (العقد طلب الرابط والنوع؛ الأخير يحتاج `opportunityType` في `customers.service.overview`).

## 6. سلوك لوحة القيادة بعد المرحلة الجديدة، و`seed-demo.js`

- **لوحة القيادة** (`GET /reference/dashboard`): «الفرص المفتوحة» وقيمة الخط (pipeline) تحسبان `stage in OPPORTUNITY_STAGE_FLOW` أي المحتمل والتأهيل وعرض السعر والتفاوض، فالفرصة في `QUALIFICATION` تُحسب مفتوحة (تحقق حيّ: فرصة نقلتها إلى تأهيل ظهرت في `openOpportunities`)؛ `WON` و`LOST` خارجهما. النتيجة مطابقة لما كان `notIn [WON, LOST]` يعطيه لأي بيانات قائمة (لا فرصة قائمة بمرحلة جديدة) ولا يتغير شيء في شكل الاستجابة.
- **`scripts/seed-demo.js` لم يحتج تصحيحاً:** لا يرسل `stage` في إنشاء الفرصة؛ وتسلسله (فرصة ← عرض ← مراجعة ← قبول ← عقد) يتوافق مع القواعد الجديدة: العرض ينقل الفرصة إلى `PROPOSAL`، والعقد يكسبها `WON`، ولا ينشئ عرضاً بعد العقد. **لم أشغّله فعلياً** (تحققتُ بالقراءة فقط)، فهو بحاجة لتشغيل واحد في مراجعتك.

## 7. الحدود المعروفة

- **الواجهة لم تُفحص بصرياً في المتصفح** (لا لقطات): ما فُحص هو `tsc` وESLint وبناء Next الناجح وتجربة API الحية بـcurl. ترتيب شريط المراحل في RTL وألوان الشارات وعرض الجداول بحاجة لمراجعتك (القسم 9 من العقد).
- **تعديل فرصة مفتوحة (`update`) غير محمي ضد إغلاقها بالتزامن:** يقرأ المرحلة ثم يكتب بالمعرّف؛ لو أُغلقت الفرصة بين القراءة والكتابة (نافذة بأجزاء من الثانية) قد يمرّ تعديل على فرصة صارت مقفلة. مسار المرحلة نفسه محمي بـ`count === 1`.
- **أسباب الخسارة تُزرع بالبذرة فقط:** الترحيل لا يضيفها. على خادم قائم لن يستطيع أحد وسم فرصة «خاسرة» حتى يشغَّل `db:seed` أو يضيف المسؤول سبباً من الإدارة (القرار في القسم 8).
- **404 على `Loss reason not found`** يظهر نصاً عاماً في الواجهة (قاعدة `errors.ts` أن 404 دائماً عامة)؛ عملياً لا يحدث لأن القائمة تجلب النشطة فقط لحظة فتح النافذة.
- **الفرص القائمة** تبقى على مراحلها ونوعها `DIRECT` وبلا `stageChangedAt` (عمر المرحلة تقريبي = عمر السجل).
- **شاشة العملاء المحتملين** لا تعرض اختيار نوع الفرصة عند التحويل (مدعوم في API فقط).
- لا تحقق في الـAPI من أن `bidBondExpiry` بعد تاريخ اليوم ولا أن الضمان يغطي تاريخ المناقصة (غير مطلوب في العقد).
- بيانات تجريبية بقيت في القاعدة المحلية: فرصة `Tender smoke` (OPP-00002) من تجربة curl، ومنشآت وفرص الاختبارات التكاملية (نمط الاختبارات الأخرى). أعادت دورة `down/up` تعيين `LossReason` وأعمدة الفرص الجديدة لمنشأة البذرة فقط.

## 8. ما يحتاج قرار المراجع

1. **أسباب الخسارة على الخادم الحي:** هل يُشغَّل `db:seed` عند نشر هذه الخطوة، أم يُضاف `INSERT ... SELECT` للأسباب الستة داخل الترحيل نفسه ليوجد لكل منشأة قائمة مباشرة بلا خطوة منفصلة؟ (العقد وضعها في البذرة؛ أبقيتُها هناك.)
2. **العقد الثاني على فرصة رابحة:** يمرّ حالياً (القسم 3)؛ والقرار 10-3 يوحي برفضه. أيّهما؟
3. **حماية `update` من الإغلاق المتزامن** (قفل `SELECT ... FOR UPDATE` أو `updateMany` مشروط بالمرحلة): أضيفها أم تكفي النافذة الضيقة؟
4. **تحقق صلاحية الضمان** (انتهاؤه بعد تاريخ إقفال المناقصة، أو مبلغ إلزامي): من الوثيقة 4.2 غير مفروض؛ هل تريده؟
5. **خيار `seed-demo.js`:** تشغيله مرة على قاعدة نظيفة للتأكد من أن تسلسله ما زال يمرّ.

## git status --short

(انظر المخرجات أدناه — التقطت بعد كتابة هذا الملف مباشرة.)

```
 M apps/api/src/modules/commercial/commercial.module.ts
 M apps/api/src/modules/commercial/contracts.service.spec.ts
 M apps/api/src/modules/commercial/contracts.service.ts
 M apps/api/src/modules/commercial/proposals.service.ts
 M apps/api/src/modules/commercial/revision-pricing.spec.ts
 M apps/api/src/modules/crm/crm.module.ts
 M apps/api/src/modules/crm/customers.service.ts
 M apps/api/src/modules/crm/dto.ts
 M apps/api/src/modules/crm/leads.service.ts
 M apps/api/src/modules/crm/opportunities.controller.ts
 M apps/api/src/modules/crm/opportunities.service.ts
 M apps/api/src/modules/platform/attachments.service.ts
 M apps/api/src/modules/reference/reference.controller.ts
 M apps/api/src/modules/search/search.service.ts
 M apps/api/test/accounting-reconciliation.int-spec.ts
 M apps/api/test/tenant-isolation.int-spec.ts
 M apps/web/src/app/(app)/admin/page.tsx
 M apps/web/src/app/(app)/customers/[id]/page.tsx
 M apps/web/src/app/(app)/opportunities/page.tsx
 M apps/web/src/components/attachments.tsx
 M apps/web/src/components/audit-log.tsx
 M apps/web/src/components/global-search.tsx
 M apps/web/src/components/ui.tsx
 M apps/web/src/lib/errors.ts
 M apps/web/src/lib/messages.ts
 M apps/web/src/lib/useEnums.ts
 M packages/db/prisma/schema.prisma
 M packages/db/prisma/seed.ts
 M packages/shared/src/enums.ts
 M packages/shared/src/index.ts
 M packages/shared/src/workflow.ts
?? apps/api/src/common/opportunity-stages.spec.ts
?? apps/api/src/modules/commercial/proposals.service.spec.ts
?? apps/api/src/modules/crm/loss-reasons.controller.ts
?? apps/api/src/modules/crm/loss-reasons.service.spec.ts
?? apps/api/src/modules/crm/loss-reasons.service.ts
?? apps/api/src/modules/crm/opportunities.service.spec.ts
?? apps/api/test/opportunity-stages.int-spec.ts
?? apps/web/src/app/(app)/opportunities/[id]/
?? apps/web/src/components/loss-reasons.tsx
?? apps/web/src/components/opportunity-bits.tsx
?? docs/crm-phase-1/step-3-agent-report.md
?? docs/crm-phase-1/step-3-opportunities-contract.md
?? packages/db/prisma/migrations/0024_crm_opportunities/
?? packages/shared/src/opportunity-stages.ts
```
