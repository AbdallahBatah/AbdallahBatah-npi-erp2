# الخطوة 3 — الفرص وقمع المبيعات (القسم 4.2 + خريطة الحالات في القسم 9): العقد الملزم للوكيل المنفّذ

> **معتمد من إياد 2026-10-07** بإيماءة «أكمل» على التقرير (الخطوة 2 موافق عليها، وقرارات القسم 10 الخمسة بالتوصية «نعم»). كُتب بعد التزام الخطوة 2 = 7eef4e0؛ يُنفَّذ في الالتزام التالي لهذا الملف. مراجعة القسم 9 تُوثَّق في `screenshots/step-3-0[1-4]-*.jpg`.
> مجلد العمل: `C:\dev\npi-erp-crm` (worktree على `feature/crm-phase-1`). القاعدة: إضافة فقط؛ لا حذف ولا تعديل عمود/جدول قائم؛ جدول `Opportunity` القائم هو السجل الوحيد (لا جدول فرص ثانٍ). `Lead` القائم خارج النطاق ويبقى كما هو.
> نص الوثيقة §4.2 (المرجع الملزم): «خمس مراحل: عميل محتمل ← تأهيل ← عرض سعر ← تفاوض ← رابحة أو خاسرة. سبب الخسارة حقل إلزامي من قائمة قابلة للتعديل. للفرصة نوعان: «مباشرة» و«مناقصة»، والمناقصة تضيف تاريخ الإقفال وبيانات الضمان الابتدائي.» §9: «الفرصة: محتمل ← تأهيل ← عرض سعر ← تفاوض ← رابحة | خاسرة». §10: الفرصة = «النوع، المرحلة، القيمة المتوقعة، تاريخ الإقفال، سبب الخسارة» وترتبط بالعميل.
> أمر التنفيذ (الخطوة 3): «نفّذ القسم 4.2 وخريطة حالات الفرصة في القسم 9. تحقق: لا تُحفظ فرصة خاسرة دون سبب، ونوع «مناقصة» يُظهر حقوله الإضافية.»

## 0. حقائق الكود الحالي (مرجع الوكيل)
- `enum OpportunityStage { PROSPECTING, PROPOSAL, NEGOTIATION, WON, LOST }` في `packages/db/prisma/schema.prisma:60-66`. **لا توجد مرحلة تأهيل.** الخريطة في الواجهة `apps/web/src/components/ui.tsx:282-286` (StatusBadge) والقائمة المشتركة `OPPORTUNITY_STAGES` في `packages/shared/src/enums.ts:42-47` تُقدَّم للواجهة عبر `reference.controller.ts:62` (`opportunityStages`) و`apps/web/src/lib/useEnums.ts:17`.
- `model Opportunity` في `schema.prisma:490-515`: `id, organizationId, code (OPP-xxxxx), name, customerId, stage @default(PROSPECTING), estimatedKwp Decimal(12,3)?, estimatedValue Decimal(18,2)?, currency, expectedCloseDate?, ownerId?, createdAt, updatedAt`؛ علاقات `sourceLead`, `designVersions`, `proposals`, `contracts`. فهرس `(organizationId, stage)`. **لا نوع، لا حقول مناقصة، لا سبب خسارة، لا تاريخ إقفال فعلي.**
- المفاتيح الأجنبية إلى الفرصة: `Proposal.opportunityId?` (:566، فهرس :578)، `Contract.opportunityId?` (:643)، `DesignVersion.opportunityId` (:586). `Lead.convertedOpportunityId? @unique` (:481).
- الخدمة `apps/api/src/modules/crm/opportunities.service.ts`: `list(stage?)`, `get` (يخفي تسعير النسخ لمن لا يملك `finance.costs.view`)، `create` (داخل معاملة + ترقيم + تدقيق؛ يرفض عميلاً مدمجاً بـ409)، `update` **خارج معاملة وتدقيقه غير ذرّي، ويقبل `stage` حرّاً بلا أي قاعدة انتقال**. المتحكم `opportunities.controller.ts`: `GET /opportunities?stage=`, `GET /:id`, `POST`, `PATCH /:id` بصلاحيتي `crm.opportunity.read/write`. DTOs في `crm/dto.ts:77-92`.
- من يغيّر المرحلة من خارج الخدمة: `commercial/contracts.service.ts:129-134` يضع `stage: 'WON'` مباشرة عند إنشاء عقد مرتبط بفرصة (داخل معاملة العقد). `commercial/proposals.service.ts:57-61` يتحقق فقط أن الفرصة تخص المنشأة **ولا يحرّك المرحلة ولا يرفض فرصة خاسرة/رابحة**. `leads.service.ts:146-156` (convert) ينشئ الفرصة بمرحلة `PROSPECTING`.
- لوحة القيادة `reference.controller.ts:106-123`: الفرص المفتوحة = `stage notIn [WON, LOST]` (مرحلة جديدة تُحسب مفتوحة تلقائياً).
- الواجهة `apps/web/src/app/(app)/opportunities/page.tsx`: قائمة + نافذة إنشاء (اسم، عميل، kWp، قيمة) + فلتر مرحلة + زر «إنشاء عرض». **لا صفحة تفاصيل `/opportunities/[id]`، ولا طريقة لتغيير المرحلة من الواجهة، ولا إدخال لتاريخ الإقفال المتوقع.** صفحة العميل `customers/[id]/page.tsx:337-350` تعرض الفرص في تبويب بلا رابط لصفحة الفرصة.
- `AttachmentEntity = CONTRACT, INVOICE, PROJECT, WORK_ORDER, CUSTOMER` (:1932-1938)؛ خريطة الصلاحيات `platform/attachments.service.ts:32-38`؛ اتحاد الأنواع في `apps/web/src/components/attachments.tsx`. **لا OPPORTUNITY** (الخطة بند 11).
- أحداث الصندوق الصادر في `packages/shared/src/workflow.ts:128-152` (`WF_EVENTS` + `WF_EVENT_LABELS`)؛ آخرها `customer.merged`.
- عرف الترحيلات: `0022`/`0023` كلٌّ بـ`migration.sql` + `down.sql` يدوي؛ إضافة قيمة enum بـ`ALTER TYPE ... ADD VALUE IF NOT EXISTS` (`0022/migration.sql:30`) مع تعليق في `down.sql` أن Postgres لا يحذف قيم enum. **قيمة enum الجديدة لا تُستخدم في ملف الترحيل نفسه** (قيد Postgres على القيم المضافة في المعاملة ذاتها).
- الإدارة: `apps/web/src/app/(app)/admin/page.tsx:84-85` تبويبات `users | roles | matrix | org | audit | merge` بمفاتيح `adm.tab.*`؛ تبويب «دمج العملاء» للخطوة 2 هو النمط للتبويب الجديد. صلاحيات الإدارة المتاحة: `admin.org.manage`, `admin.workflow.manage`, `admin.approval.manage`...
- الترجمة: مفاتيح `opps.*` في `apps/web/src/lib/messages.ts:297-303` (ar) و`:1311-1317` (en) + `opps.emptyHint` (:174/:1181). أخطاء الخادم تُترجم بأنماط في `apps/web/src/lib/errors.ts`؛ 404 يُعرض نصاً عاماً دائماً فلا يُستعمل لرسائل مخصصة.
- التدقيق `AuditService.record({organizationId, actorId, entityType, entityId, action, before?, after?}, tx?)`؛ الصندوق الصادر `OutboxService.emit(tx, {organizationId, eventCode, payload})` (المعاملة إلزامية). إعدادات المنشأة `common/org-settings.service.ts` (`get<T>(org, key, default)` / `set`).
- المال: الكود الجديد بـ`Prisma.Decimal` حصراً (قرار الخطة بند 10).
- اختبارات التكامل `apps/api/test/*.int-spec.ts` تبني الخدمات يدوياً بلا Nest، وترفض `DATABASE_URL` غير محلي، و`AuthUser` يُبنى بـ`permissions:['*']`. تشغيلها `npm run test:int` من الجذر؛ الوحدة `npm test` من الجذر لا `npx jest`.
- البذرة: فرصة واحدة تُنشأ عبر تحويل `LEAD-00001` فقط عند تشغيل سيناريو التحويل؛ `seed.ts:217` ترقيم `OPPORTUNITY/OPP`.

## 1. قاعدة البيانات — ترحيل واحد `0024_crm_opportunities` (إضافة فقط + `down.sql`)
- قيمة enum جديدة: `ALTER TYPE "OpportunityStage" ADD VALUE IF NOT EXISTS 'QUALIFICATION' AFTER 'PROSPECTING'`. في `schema.prisma` تُدرج بين `PROSPECTING` و`PROPOSAL`. لا تعبئة بيانات: الفرص القائمة تبقى على مراحلها.
- enum جديد `OpportunityType { DIRECT, TENDER }`.
- جدول جديد `LossReason { id, organizationId, nameAr, nameEn, isActive Boolean @default(true), sortOrder Int @default(0), createdAt, updatedAt }` بتفرّد `(organizationId, nameAr)` وفهرس `(organizationId, isActive, sortOrder)`؛ `onDelete: Cascade` على المنشأة فقط. **لا حذف فعلي لسبب** مستخدَم؛ التعطيل بـ`isActive=false`.
- أعمدة جديدة على `Opportunity` (كلها nullable أو بقيمة افتراضية): `opportunityType OpportunityType @default(DIRECT)`، `tenderReference String?` (رقم/مرجع المناقصة)، `tenderCloseDate DateTime?` (تاريخ إقفال المناقصة = آخر موعد لتقديم العطاء)، `bidBondAmount Decimal(18,2)?`، `bidBondBank String?`، `bidBondExpiry DateTime?`، `bidBondReference String?` (بيانات الضمان الابتدائي)، `lossReasonId String?` + علاقة `lossReason LossReason?` (`onDelete: Restrict`)، `lossNotes String?`، `closedAt DateTime?` (لحظة الانتقال إلى رابحة/خاسرة)، `stageChangedAt DateTime?` (آخر تغيير مرحلة؛ لعمر المرحلة في القائمة). فهارس: `(organizationId, opportunityType)`, `(lossReasonId)`.
- `AttachmentEntity.OPPORTUNITY` (`ADD VALUE IF NOT EXISTS`).
- `down.sql`: حذف الأعمدة والفهارس الجديدة من `Opportunity`، حذف `LossReason`، حذف enum `OpportunityType`؛ تعليق صريح أن `QUALIFICATION` و`OPPORTUNITY` لا تُحذفان من enum (عرف 0020/0022) — وأن `down` يفشل عمداً إن وُجدت فرصة بمرحلة `QUALIFICATION` (الوكيل يوثّق ذلك في رأس الملف).

## 2. المشترك (`packages/shared/src`)
- `enums.ts`: `OPPORTUNITY_STAGES` تصبح بالترتيب `PROSPECTING (محتمل) → QUALIFICATION (تأهيل) → PROPOSAL (عرض سعر) → NEGOTIATION (تفاوض) → WON (رابحة) | LOST (خاسرة)`؛ العناوين العربية **كما في الوثيقة**: «محتمل، تأهيل، عرض سعر، تفاوض، رابحة، خاسرة» (تُصحَّح «استكشاف/مكسوبة» الحالية في `enums.ts` و`ui.tsx`). قائمة جديدة `OPPORTUNITY_TYPES` (`DIRECT` مباشرة / `TENDER` مناقصة).
- ملف جديد `opportunity-stages.ts`: `OPPORTUNITY_STAGE_FLOW = ['PROSPECTING','QUALIFICATION','PROPOSAL','NEGOTIATION']` (المفتوحة بالترتيب) + `OPPORTUNITY_TERMINAL = ['WON','LOST']` + دالة نقية `opportunityTransition(from, to): { ok: true } | { ok: false; reason: 'TERMINAL' | 'SKIP' | 'UNKNOWN' }` بالقواعد:
  - من مرحلة مفتوحة إلى **المرحلة التالية مباشرة**: مسموح.
  - من مرحلة مفتوحة إلى **أي مرحلة مفتوحة سابقة**: مسموح (تراجع؛ القرار 10-1) ويُسجَّل تدقيقاً بوسم `backward: true`.
  - القفز للأمام أكثر من مرحلة: مرفوض (`SKIP`) — إلا عبر المسارين النظاميين في §3 (إنشاء عرض ← `PROPOSAL`، إنشاء عقد ← `WON`).
  - إلى `LOST`: مسموح من أي مرحلة مفتوحة.
  - إلى `WON`: مسموح من `NEGOTIATION` يدوياً، ومن أي مرحلة مفتوحة عبر إنشاء عقد فقط.
  - من `WON` أو `LOST` إلى أي شيء: مرفوض (`TERMINAL`) — إعادة الفتح = فرصة جديدة (القرار 10-1).
  - `isOpenStage(stage)` مساعد تستعمله لوحة القيادة والقوائم بدل التكرار الحرفي `notIn [WON, LOST]` (يُستبدل في `reference.controller.ts:106-123` لأنه يُلمس مباشرة؛ السلوك لا يتغير).
- `workflow.ts`: حدثان `opportunity.won` و`opportunity.lost` في `WF_EVENTS` مع عناوين في `WF_EVENT_LABELS`؛ الحمولة `{ opportunityId, code, customerId, stage, lossReasonId?, estimatedValue }`. تغيير المرحلة بين المفتوحة يُسجَّل تدقيقاً لا حدثاً.
- `permissions.ts`: لا مفاتيح جديدة. إدارة أسباب الخسارة تحت `admin.org.manage` (قائمة مرجعية للمنشأة)؛ تغيير المرحلة ووسم الخسارة تحت `crm.opportunity.write` القائم.

## 3. الخدمة (`modules/crm/opportunities.service.ts` + ملف جديد)
- **DTOs** (`crm/dto.ts`): `CreateOpportunityDto` يكسب `opportunityType?` (افتراضي `DIRECT`)، `expectedCloseDate` (موجود)، `tenderReference?`, `tenderCloseDate?`, `bidBondAmount?`, `bidBondBank?`, `bidBondExpiry?`, `bidBondReference?`، ويفقد `stage` (الفرصة تُولد `PROSPECTING` دائماً؛ المرحلة تُغيَّر بالمسار الصريح). `UpdateOpportunityDto` نفسه بلا `stage`؛ إرسال `stage` في `PATCH` يُرفض بـ400 `Stage changes go through /stage`. DTO جديد `ChangeStageDto { stage, lossReasonId?, lossNotes? }`.
- **قاعدة المناقصة**: إن كان النوع `TENDER` فـ`tenderCloseDate` **إلزامي** (400 `Tender close date is required`)؛ بقية حقول الضمان اختيارية. إن كان النوع `DIRECT` تُتجاهَل/تُصفَّر حقول المناقصة عند الحفظ (لا يُحفظ ضمان على فرصة مباشرة). تغيير النوع من مناقصة إلى مباشرة مسموح في المراحل المفتوحة ويُصفّر حقول المناقصة مع تدقيق.
- **المسار الصريح** `POST /opportunities/:id/stage` (صلاحية `crm.opportunity.write`) ← `changeStage(user, id, dto)` داخل `$transaction`: يجلب الفرصة بقفل (`SELECT ... FOR UPDATE` عبر `$queryRaw` أو `findFirst` ثم `updateMany` مشروطاً بالمرحلة القديمة مع فحص `count === 1`؛ الوكيل يختار الثانية فهي عرف المستودع في `concurrency.int-spec.ts`)، يطبّق `opportunityTransition`؛ الرفض 409 برسالة ثابتة تبدأ بـ`Invalid stage transition:` مع `{ code: 'OPPORTUNITY_STAGE', from, to, reason }`. إلى `LOST`: `lossReasonId` **إلزامي** (400 `Loss reason is required`)، ويجب أن يكون نشطاً ويخص المنشأة (404 `Loss reason not found`)؛ `lossNotes` اختياري. يضع `stageChangedAt = now()`، وعند `WON/LOST` يضع `closedAt = now()`؛ عند `WON` يُصفّر `lossReasonId/lossNotes`. تدقيق `STAGE_CHANGE` بـ`before/after` (+ `backward` في `after` عند التراجع)، وحدث `opportunity.won`/`opportunity.lost` عبر `OutboxService.emit`.
- **المساران النظاميان (خارج الخدمة، يُلمسان مباشرة):**
  - `proposals.service.create` (:57-61): إن كانت الفرصة `WON` أو `LOST` → 409 `Opportunity is closed` (الوثيقة 4.3: بعد الربح لا تعديل إلا بأمر تغيير). إن كانت `PROSPECTING` أو `QUALIFICATION` → تُنقل إلى `PROPOSAL` داخل معاملة إنشاء العرض مع تدقيق `STAGE_CHANGE` بوسم `via: 'proposal'` (القرار 10-2). إن كانت `PROPOSAL`/`NEGOTIATION` لا تتغير.
  - `contracts.service.create` (:129-134): يبقى يضع `WON` لكن عبر دالة مشتركة `markWonViaContract(tx, opp, user)` تُصدَّر من `opportunities.service`: ترفض `LOST` بـ409 `Opportunity is closed`، وتضع `WON + closedAt + stageChangedAt` وتدقيق `STAGE_CHANGE` بوسم `via: 'contract'` وحدث `opportunity.won` — بدلاً من `update` الصامت الحالي (القرار 10-3). إن كانت `WON` أصلاً (عقد ثانٍ على فرصة رابحة) لا تتغير ولا يُرفض العقد.
- `update` يصبح داخل `$transaction` بتدقيق ذرّي (إصلاح الفجوة القائمة نفسها التي أُصلحت للعملاء). الحقول القابلة للتعديل في `WON/LOST`: لا شيء سوى `name` و`lossNotes` (الفرصة المقفلة سجل تاريخي؛ 409 `Opportunity is closed` لغيرها).
- `list` يكسب فلاتر `?type=` و`?open=1` (المفتوحة فقط) ويعيد `opportunityType, expectedCloseDate, tenderCloseDate, stageChangedAt, lossReason {nameAr,nameEn}`. `get` يعيد `lossReason` و`contracts {id, code, status}`.
- **أسباب الخسارة** `loss-reasons.service.ts` + `loss-reasons.controller.ts`: `GET /loss-reasons` (صلاحية `crm.opportunity.read`؛ `?all=1` يعيد المعطَّلة أيضاً لمن يملك `admin.org.manage`)، `POST`/`PATCH /loss-reasons/:id` (صلاحية `admin.org.manage`): إنشاء، تعديل الاسمين والترتيب، تفعيل/تعطيل. **لا `DELETE`.** تدقيق `CREATE/UPDATE` بكيان `LossReason`. تكرار الاسم العربي → P2002 → 409.
- `leads.convert` لا يتغير إلا بتمرير `opportunityType?` اختيارياً من DTO التحويل (افتراضي `DIRECT`).

## 4. المرفقات والبحث
- `AttachmentEntity.OPPORTUNITY` في enum + `ENTITY_READ_PERMISSION` (`crm.opportunity.read`) + `assertEntityExists` + اتحاد الأنواع في `attachments.tsx`.
- `search.service.ts`: الفرص تُبحث بالاسم والرمز و`tenderReference`، و`href` يصبح `/opportunities/{id}`.

## 5. الواجهة (`apps/web`)
- `/opportunities`: الصفوف تنقل إلى `/opportunities/[id]`؛ أعمدة جديدة: النوع (شارة «مناقصة» بلون مميز)، تاريخ الإقفال المتوقع، وعمر المرحلة بالأيام من `stageChangedAt`؛ فلتر النوع بجانب فلتر المرحلة؛ فلتر المرحلة يعرض الترتيب الجديد بالعناوين العربية الجديدة. نافذة الإنشاء تكسب: النوع (مباشرة/مناقصة)، تاريخ الإقفال المتوقع، و**حقول المناقصة تظهر فقط عند اختيار «مناقصة»** (مرجع المناقصة، تاريخ إقفال المناقصة *إلزامي*، مبلغ الضمان الابتدائي، البنك، انتهاؤه، مرجعه). زر «إنشاء عرض» يختفي للفرص المقفلة.
- صفحة جديدة `/opportunities/[id]`: ترويسة (الرمز، الاسم، العميل برابط `/customers/[id]`، النوع، القيمة التقديرية، kWp، المالك، تاريخ الإقفال المتوقع، زر تعديل بنافذة `Modal`). **شريط المراحل** (stepper) بالمراحل الخمس المفتوحة/المقفلة: المرحلة الحالية مميزة؛ زر «الانتقال إلى {المرحلة التالية}»؛ زر «رجوع إلى {السابقة}» (أصغر) للمراحل المفتوحة؛ زر «وسم كخاسرة» يفتح نافذة تطلب **سبب الخسارة من القائمة (إلزامي) + ملاحظات**؛ زر «وسم كرابحة» يظهر في «تفاوض» فقط مع تلميح «يُفضَّل إنشاء العقد فيكسب الفرصة تلقائياً». فرصة مقفلة: شريط «رابحة بتاريخ…» أو «خاسرة بتاريخ… — السبب: …» ولا أزرار انتقال. بطاقة «المناقصة» تظهر للنوع `TENDER` فقط (المرجع، تاريخ الإقفال مع تحذير أحمر إن مضى أو بقي أقل من 7 أيام، الضمان الابتدائي). تبويبات `Tabs`: **العروض** (من `get`؛ زر إنشاء عرض لمن يملك `commercial.proposal.write` وللفرص المفتوحة) | **العقود** | **المرفقات** (`AttachmentsCard entityType="OPPORTUNITY"`). تبويبا «سجل التواصل» و«المهام» في الخطوة 5.
- صفحة العميل `customers/[id]`: صفوف تبويب الفرص تصبح روابط إلى `/opportunities/[id]` وتعرض النوع.
- `/admin` تبويب جديد «أسباب الخسارة» (`lossReasons`؛ يظهر لمن يحمل `admin.org.manage`): جدول (الاسم عربي/إنجليزي، الترتيب، نشط) + إنشاء/تعديل بنافذة + تبديل التفعيل. لا حذف.
- `ui.tsx` StatusBadge: إضافة `QUALIFICATION` وتصحيح العناوين العربية لـ`PROSPECTING`/`WON`.
- مفاتيح i18n جديدة بالعربية والإنجليزية تحت `opps.*` (مثلاً `opps.type`, `opps.type.DIRECT`, `opps.type.TENDER`, `opps.expectedClose`, `opps.tender.*`, `opps.bidBond.*`, `opps.stage.next`, `opps.stage.back`, `opps.markLost`, `opps.markWon`, `opps.lossReason`, `opps.lossNotes`, `opps.closed.won`, `opps.closed.lost`, `opps.tab.*`, `adm.tab.lossReasons`, `lossReasons.*`)، وأنماط `errors.ts` لـ`Invalid stage transition`, `Loss reason is required`, `Tender close date is required`, `Opportunity is closed`, `Stage changes go through`.

## 6. الزرع والسكربتات
- `seed.ts`: ستة أسباب خسارة افتراضية لكل منشأة مزروعة (بالترتيب): «السعر»، «اختيار منافس»، «إلغاء المشروع أو تأجيله»، «عدم توفر التمويل»، «عدم استيفاء شروط المناقصة»، «أخرى»، مع الإنجليزية. فرصة البذرة (إن وُجدت) تبقى `DIRECT`.
- `scripts/seed-demo.js` يبقى كما هو ما لم يُرسل `stage` في إنشاء الفرصة؛ إن فعل يُصحَّح باستعمال `/stage`.

## 7. الاختبارات (قبل الكود، بأدلة قبل/بعد)
- وحدة `packages/shared/src/opportunity-stages.spec.ts`: جدول الانتقالات كاملاً (التالية مسموحة، القفز مرفوض `SKIP`، التراجع مسموح، `LOST` من كل مفتوحة، `WON` من `NEGOTIATION` فقط يدوياً، لا خروج من `WON/LOST` = `TERMINAL`).
- وحدة `opportunities.service.spec.ts`: خاسرة بلا سبب → 400؛ سبب معطَّل أو من منشأة أخرى → 404؛ مناقصة بلا تاريخ إقفال → 400؛ `PATCH` بـ`stage` → 400؛ تعديل فرصة مقفلة → 409؛ تغيير النوع إلى مباشرة يُصفّر حقول المناقصة.
- وحدة `loss-reasons.service.spec.ts`: اسم مكرر → 409؛ التعطيل لا يحذف؛ القائمة الافتراضية تستبعد المعطَّلة.
- تحديث `contracts.service.spec.ts:74` ليمر عبر `markWonViaContract` (عقد على فرصة خاسرة → 409).
- تكامل `apps/api/test/opportunity-stages.int-spec.ts` على القاعدة المحلية: (1) فرصة جديدة `PROSPECTING` → `QUALIFICATION` عبر `/stage` → إنشاء عرض ينقلها تلقائياً إلى `PROPOSAL` مع تدقيق `via: proposal` → `NEGOTIATION` → `LOST` بسبب نشط؛ يُثبت `closedAt`، وصف الصندوق الصادر `opportunity.lost`، ورفض عرض جديد عليها بـ409. (2) فرصة ثانية: إنشاء عقد من `PROPOSAL` يكسبها `WON` مع حدث `opportunity.won`؛ محاولة `/stage` بعدها → 409 `TERMINAL`. (3) تزامن: طلبان متوازيان لتغيير المرحلة من `QUALIFICATION` إلى `PROPOSAL` ينجح أحدهما ويُرفض الآخر (نمط `concurrency.int-spec.ts`).
- `tenant-isolation.int-spec.ts`: `GET /loss-reasons` و`POST /opportunities/:id/stage` بسبب خسارة من منشأة أخرى لا يريان/لا يقبلان بيانات منشأة أخرى.

## 8. القبول قبل تسليم الوكيل
`npm run typecheck && npm run lint && npm test` خضراء، `npm run db:deploy && npm run db:seed` بلا أخطاء، `npm run test:int` خضراء على القاعدة المحلية، دورة `down.sql` لـ0024 ثم إعادة الترحيل تعمل (مع توثيق أن `QUALIFICATION` تبقى في enum). التقرير يذكر كل ملف مُعدَّل، وسلوك لوحة القيادة بعد المرحلة الجديدة، وما إذا كان `seed-demo.js` احتاج تصحيحاً.

## 9. مراجعة النموذج الرئيسي (قبل العرض على إياد)
تشغيل API وWeb من الـworktree والتحقق بمدخلات حقيقية: (1) إنشاء فرصة «مناقصة» لمصنع الرياض للصناعات: الحقول الإضافية تظهر عند اختيار النوع، والحفظ بلا تاريخ إقفال يُرفض برسالة عربية؛ (2) صفحة الفرصة: الانتقال محتمل ← تأهيل، ثم «إنشاء عرض» ينقلها إلى «عرض سعر» تلقائياً؛ (3) «وسم كخاسرة» بلا سبب مرفوض، ومع سبب من القائمة يقفل الفرصة ويعرض الشريط؛ (4) تبويب «أسباب الخسارة» في الإدارة: إضافة سبب جديد وتعطيل آخر، والمعطَّل يختفي من قائمة الخسارة. لقطات في `docs/crm-phase-1/screenshots/step-3-*`. ثم العرض على إياد بلغة غير برمجية وانتظار موافقته قبل الخطوة 4.

## 10. ما يُعرض على إياد للقرار (مع التوصية)
1. **قواعد الحركة بين المراحل**: التقدم خطوة واحدة في كل مرة، والتراجع إلى أي مرحلة مفتوحة سابقة مسموح ويُسجَّل، و«رابحة/خاسرة» نهائيتان (إعادة الفتح = فرصة جديدة) — **التوصية: نعم**. البديل: منع التراجع نهائياً (يُجبر المبيعات على إنشاء فرص مكررة عند إعادة التفاوض).
2. **إنشاء عرض السعر ينقل الفرصة تلقائياً إلى «عرض سعر»** إن كانت قبلها — **التوصية: نعم**. البديل: يبقى يدوياً فتتخلف المرحلة عن الواقع كما يحدث اليوم.
3. **إنشاء العقد يكسب الفرصة** (السلوك الحالي يبقى) لكن عبر القاعدة الموحدة التي ترفض فرصة خاسرة، **والفرصة المقفلة ترفض عروضاً وعقوداً جديدة** (الوثيقة 4.3: بعد الربح لا تعديل إلا بأمر تغيير) — **التوصية: نعم**.
4. **بيانات الضمان الابتدائي حقول على الفرصة نفسها** (المبلغ، البنك، تاريخ الانتهاء، المرجع) لا جدول ضمانات مستقل — الوثيقة §10 تربط «الضمان البنكي» بالعقد وهو من المرحلة الثانية (المشاريع) — **التوصية: نعم**.
5. **ستة أسباب خسارة افتراضية** تُزرع وتُعدَّل من الإدارة، والتعطيل بدل الحذف حفاظاً على تاريخ الفرص الخاسرة — **التوصية: نعم**.

## 11. قرارات ما بعد المراجعة (CRM-S3-b، 2026-10-08 — قرار إياد: «نفذ توصيتك»)
على أسئلة تقرير الوكيل §8:
1. **العقد الثاني على فرصة رابحة يُرفض** بـ409 `Opportunity is closed`، كالخاسرة تماماً (القرار 10-3 يعلو على استثناء القسم 3 أعلاه). الفرصة المقفلة، رابحة أو خاسرة، لا تقبل عرضاً ولا عقداً جديداً؛ عمل إضافي على عميل رابح = فرصة جديدة. التنفيذ في `markWonViaContract` وحده، والاختبارات (وحدة وتكامل) تثبت أنه لا يُنشأ عقد ولا يُكرَّر حدث `opportunity.won`.
2. **أسباب الخسارة الستة داخل الترحيل** `0025_loss_reasons_backfill`: `INSERT ... SELECT` لكل منشأة قائمة مع `ON CONFLICT ("organizationId", "nameAr") DO NOTHING`؛ لا تعديل على 0024 المطبَّق، والبذرة تبقى كما هي (idempotent، لا تلمس سبباً عدّله المدير). النشر على الخادم الحي لا يحتاج `db:seed`.
3. **حماية `update` من الإغلاق المتزامن تبقى كما هي** (قراءة ثم كتابة بلا قفل). النافذة ضيقة: `update` لا يكتب المرحلة، وأسوأ أثر لها تعديلُ حقلٍ وصفي على فرصة أُقفلت في اللحظة نفسها، وهو مدقَّق في سجل التدقيق. يُعاد النظر إن ظهر في الواقع.
4. تحقق صلاحية الضمان الابتدائي والتشغيل التجريبي لـ`seed-demo.js`: غير مطلوبَين الآن (الأول خارج الوثيقة 4.2، والثاني شُغِّل في المراجعة الحية للخطوة 3).

