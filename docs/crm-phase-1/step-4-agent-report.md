# الخطوة 4 — عرض السعر بنسخه المرقّمة واعتماده: تقرير الوكيل المنفّذ

> الحالة: كل شيء في شجرة العمل غير ملتزَم (لا commit ولا push ولا stash). مجلد العمل `C:\dev\npi-erp-crm` على `feature/crm-phase-1` (HEAD 543ca57). القاعدة المحلية كانت متاحة طوال الجلسة. المستخدمون المزروعون الفعليون: `sales@npi.sa / Sales@123`، `ceo@npi.sa / Ceo@12345`، `admin@npi.sa / Admin@123` (كلمة مرور المندوب في التعليمات كانت تخميناً؛ الصحيح من `seed.ts`).

## 1. ملخص التنفيذ

نُفِّذ العقد بأقسامه 1–9 كاملة: اختبارات أولاً (وحدة + تكامل) وسُجِّل فشلها لأسباب متوقعة (ثمانية ملفات وحدة لا تُجمَّع و55 خطأ تجميع في ملف التكامل)، ثم الترحيلان `0026_crm_proposals` (مخطط فقط: أربع حالات جديدة لـ`ProposalStatus`، `PROPOSAL` في `ApprovalDocument`، enum `CostSource`، سبعة أعمدة على `ProposalRevision`، ثمانية على `BomLine`، فهرس `(status, validUntil)`) و`0027_crm_proposals_backfill` (بيانات فقط في معاملتها: الإعدادان، قاعدة «كل عرض ← الإدارة العليا»، تدفق `PROPOSAL` بسبع حالات واثنتي عشرة انتقالاً، وتبنّي العروض القائمة) مع `down.sql` يدوي لكل منهما. في المشترك: `PROPOSAL` في المصفوفة والتدفقات، `EXPIRE/REVISE`، أحداث `proposal.*`، الحالات الثماني بالعناوين العربية، `COST_SOURCES`، ودوال التواريخ والعمر النقية. في النواة: الفاعل النظامي `SystemActor` (للانتهاء فقط) و`engine.adopt` و`OrgSettingsService.getEditable/setEditable` و`GET/PATCH /admin/settings`. في الـAPI: `ItemCostService` (آخر استلام مقبول ← آخر أمر شراء معتمد ← الكتالوج، استعلام لكل مصدر لا لكل صنف)، و`ProposalsService` أُعيد بناؤه (Decimal، التكلفة يجلبها الخادم، التعديل اليدوي بسبب إلزامي مع حفظ الأصل، النسخ المرقّمة بقفل السابقة، `submit` عبر `engine.assertCan` ← `approvals.gate` ← `engine.transition` مع فحص «معتمِد آخر» وقفل لكل عرض، `applier/rejecter` مسجَّلان، `send`، قبول العميل ورفضه، `expireBySystem`)، و`ProposalExpiryScheduler` ليلي. في الواجهة: قائمة العروض بالصلاحية وشارة الانتظار، وصفحة العرض بالبانر وبطاقة لكل نسخة (الأحدث أولاً، المُستبدَلة مطوية) وعمود التكلفة والمصدر والعمر والبند المعدَّل مميَّزاً، والنموذج بجلب التكلفة وسبب التعديل، وأزرار مشتقة من `actions` القادمة من المحرك، ورابط «فتح المستند» في الاعتمادات، وبطاقة إعدادات العروض في الإدارة. `scripts/seed-demo.js` صُحِّح ومرَّ فعلياً. كل بوابات §9 خضراء بعد دورة `down.sql` وإعادة الترحيل: jest **434** (كان 334)، test:int **113** (كان 79)، typecheck وlint نظيفان، وبناء Next ينجح.

## 2. الملفات

### db
- `packages/db/prisma/migrations/0026_crm_proposals/migration.sql` (جديد): ما سبق. الحالات الجديدة تُضاف بـ`ADD VALUE IF NOT EXISTS ... AFTER` فيقرأ الـenum بترتيب الوثيقة (جُرِّبت صيغة الإضافة المتتالية داخل معاملة على نوع مؤقت). لا استعمال لأي قيمة جديدة داخل الملف.
- `packages/db/prisma/migrations/0026_crm_proposals/down.sql` (جديد): يفشل عمداً (معاملة واحدة، لا يتغير شيء) إن وُجدت نسخة أو عرض في إحدى الحالات الأربع الجديدة، أو طلب/قاعدة اعتماد `PROPOSAL`؛ رأسه يذكر الأوامر التصحيحية؛ يحذف الأعمدة والفهرس والقيد الأجنبي وenum `CostSource`؛ وتعليق أن قيم الـenum الجديدة تبقى.
- `packages/db/prisma/migrations/0027_crm_proposals_backfill/migration.sql` (جديد): لكل منشأة، idempotent (`WHERE NOT EXISTS` / `ON CONFLICT DO NOTHING`): `crm.proposal.validityDays=30` و`crm.proposal.costAgeWarnDays=30`، قاعدة `PROPOSAL` من 0 بلا سقف بخطوة واحدة للدور `executive` (فقط حيث الدور موجود ولا قاعدة نشطة)، تعريف التدفق (7 حالات و12 انتقالاً بالنص العربي)، ومثيل لكل عرض قائم بحالته مع صف `ADOPT` بلا فاعل (و`closedAt` لـ`ACCEPTED`).
- `packages/db/prisma/migrations/0027_crm_proposals_backfill/down.sql` (جديد): يفشل إن وُجدت سلسلة `PROPOSAL` بحالة `PENDING`؛ يحذف المثيلات والتاريخ، التعريف (وحالاته وانتقالاته)، القاعدة، والإعدادين.
- `packages/db/prisma/schema.prisma`: enum `ProposalStatus` الثماني، `CostSource`، `PROPOSAL` في `ApprovalDocument`، أعمدة `ProposalRevision` (`validUntil, submittedAt, approvedAt, sentAt, closedAt, supersededById, createdById` + علاقة `createdBy` + فهرس) وأعمدة `BomLine`، وعلاقة عكسية على `User`.
- `packages/db/prisma/seed.ts`: تدفق `PROPOSAL` (نفس نص 0027)، `matrixDefaults` += `PROPOSAL/0/['executive']`، مجموعة تبنٍّ للعروض القائمة، وصفّا الإعدادات (upsert بـ`update: {}`).

### shared
- `packages/shared/src/proposal-dates.ts` (جديد): `riyadhDateKey`، `riyadhDayStart`، `normalizeValidUntil`، `isValidityExpired`، `isValidityFuture`، `costAge`، `isStale` (انظر الانحراف 1).
- `packages/shared/src/approvals.ts`: `'PROPOSAL'` وعنصره (`labelAr 'عرض سعر'`، الصلاحية `commercial.proposal.approve`، «إجمالي العرض (سعر البيع)»).
- `packages/shared/src/workflow.ts`: `WF_FLOWS.PROPOSAL` و`WF_FLOW_DOCUMENT_TYPE` و`WF_FLOWS_META` (`/proposals/:id`)، `WF_ACTIONS.EXPIRE/REVISE`، `WF_SYSTEM_ACTIONS`، أحداث `proposal.approved/sent/accepted/expired` وعناوينها.
- `packages/shared/src/enums.ts`: `PROPOSAL_STATUSES` الثماني بالعناوين العربية كما في الوثيقة، و`COST_SOURCES`.
- `packages/shared/src/permissions.ts`: `COST_FIELDS` += `originalUnitCost`. `index.ts`: تصدير الملف الجديد.

### api
- `apps/api/src/common/proposal-pricing.ts` (جديد): `priceRevision` و`sellingPrice` بـ`Prisma.Decimal` وتقريب `ROUND_HALF_UP` لمنزلتين لكل سطر.
- `apps/api/src/common/workflow/workflow.engine.ts`: `SystemActor`/`Actor`/`isSystemActor`، `transition(actor, …)` و`assertCan` يقبلان الفاعل النظامي (يتخطى فحص الصلاحية، `actorId = null` في التاريخ والتدقيق والحدث، ولا يُسمح له إلا بإجراءات `WF_SYSTEM_ACTIONS`)، و`adopt(tx, …)`.
- `apps/api/src/common/org-settings.service.ts`: المفتاحان والافتراضيان، `ORG_SETTING_EDITABLE` بمدقّق لكل مفتاح، `getEditable`، `setEditable` (معاملة واحدة، تدقيق لكل مفتاح، `Unknown setting key` / `Setting value out of range`).
- `apps/api/src/modules/admin/admin.controller.ts`: `GET/PATCH /admin/settings` (`admin.org.manage`).
- `apps/api/src/modules/commercial/item-cost.service.ts` (جديد)، `proposal-expiry.scheduler.ts` (جديد، `@Cron('30 1 * * *', Asia/Riyadh)` + `sweep(now)`).
- `apps/api/src/modules/commercial/proposals.service.ts` (أُعيدت كتابته)، `proposals.controller.ts` (`GET cost-lookup` قبل `:id`، `PATCH :id/revisions/:revisionId`، `POST :id/submit`، `:id/send`، `:id/reject`)، `dto.ts` (`unitCost?`، `costOverrideReason?`، `unitPrice?` اختياري، `validUntil?`، `RejectProposalDto`)، `revision-pricing.ts` (`hideRevisionPricing` يميّز النسخ الجديدة من القديمة، `isCostBasedRevision`)، `commercial.module.ts`.
- `apps/api/src/modules/reference/reference.controller.ts`: `costSources` في `/reference/enums`. `apps/api/src/modules/search/search.service.ts`: مجموعة `proposals` (الرمز أو اسم الفرصة).

### web
- `apps/web/src/app/(app)/proposals/page.tsx`: عمود الصلاحية (أحمر إن مضت أو بقي ≤7 أيام وهي ما زالت حيّة)، شارة «بانتظار اعتماد: الدور»، فلتر الحالة بالحالات الثماني.
- `apps/web/src/app/(app)/proposals/[id]/page.tsx` (أُعيدت كتابتها): البانر وسلسلة الاعتماد، شريط أزرار من `actions`، بطاقة لكل نسخة، جدول البنود بالتكلفة والمصدر وشارة العمر (أخضر/أصفر/رمادي) وصف كهرماني للبند المعدَّل يدوياً بتكلفته الأصلية مشطوبة وسببه (لمن يحمل `finance.costs.view` فقط)، نموذج النسخة (تعديل/جديدة) بجلب التكلفة وحقل سبب التعديل وفحص عميل بالجملة العربية نفسها، نافذة رفض العميل، سجل العرض، وإنشاء العقد (القائم).
- `apps/web/src/components/proposal-settings.tsx` (جديد) وتركيبه في تبويب المنشأة من `admin/page.tsx`.
- `apps/web/src/components/approvals.tsx`: `PROPOSAL` (و`PURCHASE_REQUISITION` الناقص) في الأنواع والتسميات، ورابط «فتح المستند» لصفوف `PROPOSAL`.
- `apps/web/src/components/ui.tsx`: `PENDING_APPROVAL` و`EXPIRED` و`SUPERSEDED` في `StatusBadge`. `global-search.tsx`: مجموعة العروض. `lib/useEnums.ts`: `costSources`. `lib/errors.ts`: 23 نمطاً لرسائل الخادم الجديدة. `lib/messages.ts`: مفاتيح `proposals.*` و`confirm.*` و`apr.openDocument` و`adm.settings.proposals.*` بالعربية والإنجليزية.

### tests
- جديدة: `common/proposal-pricing.spec.ts` (16)، `common/org-settings.service.spec.ts` (15)، `commercial/item-cost.service.spec.ts` (6)، `commercial/proposal-expiry.scheduler.spec.ts` (6)، `test/proposal-lifecycle.int-spec.ts` (25)، `test/support/proposal-stack.ts` (تجميع الخدمات الحقيقية + `authUserFor` + `cloneProposalFlow`).
- موسَّعة: `commercial/proposals.service.spec.ts` (46، كان 2)، `common/workflow/workflow.engine.spec.ts` (31)، `common/approval.service.spec.ts` (32)، `commercial/revision-pricing.spec.ts` (13)، `test/tenant-isolation.int-spec.ts` (+9)، `test/opportunity-stages.int-spec.ts` (بناء الخدمات من التجميع المشترك + نسخ تدفق `PROPOSAL` للمنشأة التجريبية).

### seed
- `packages/db/prisma/seed.ts` (أعلاه). `scripts/seed-demo.js`: سلسلة جديدة (رفع ← اعتماد `ceo@npi.sa` عبر `GET /approvals/inbox` و`POST /approvals/:id/decide` ← إرسال ← قبول)، وتسعير البنود بسعر البيع (السعر القديم × (1 + هامش المخطط))؛ وبثلاث درجات: المستشفى حتى القبول، المصنع حتى الإرسال، المجمع حتى الانتظار في صندوق الرئيس.

## 3. البوابات

كلها من جذر المستودع، بعد دورة `down.sql` الأخيرة وإعادة الترحيل:

| الأمر | النتيجة |
|---|---|
| `npm run typecheck` | db / shared / api / web: `tsc --noEmit` بلا أخطاء |
| `npm run lint` | `eslint .` بلا مخرجات (نظيف) |
| `npm test` | `Test Suites: 36 passed, 36 total` / `Tests: 434 passed, 434 total` (الأساس 334، +100) |
| `npx prisma migrate deploy --schema packages/db/prisma/schema.prisma` | أول تطبيق: `Applying migration 0026_crm_proposals` / `0027_crm_proposals_backfill` / `All migrations have been successfully applied.`؛ بعد الدورة الأخيرة مرة ثانية بالنتيجة نفسها؛ وبعدها `No pending migrations to apply.` |
| `npm run db:seed` | `✅ Seed complete.` (idempotent؛ شُغِّل بعد كل إعادة ترحيل) |
| `npm run test:int` | `Test Suites: 7 passed, 7 total` / `Tests: 113 passed, 113 total` (الأساس 79، +34)؛ `proposal-lifecycle` وحده 25 |
| `npm run build -w @npi/web` | `✓ Compiled successfully`؛ `/proposals` (2.27 kB) و`/proposals/[id]` (8.2 kB) و`/admin` مبنية |
| `prisma migrate diff` (القاعدة ← المخطط) | لا فروق تخص هذه الخطوة؛ يبقى فرقان قديمان لا علاقة لهما (`GoodsReceiptLine.serials` default وتسمية فهرس `ApprovalRule`) كما في الخطوة 3 |

**دورة `down.sql` (قاعدة محلية)، نُفِّذت مرتين (قبل تعديل ترتيب القيم في 0026 وبعده):**
1. مع سلسلة اعتماد `PROPOSAL` معلّقة: `Error: ERROR: Rollback of 0027 refused: a PROPOSAL approval chain is still PENDING. Decide or reject it first (see the header of down.sql).` — ولم يتغير شيء.
2. بعد حذف السلسلة: down 0027 → `Script executed successfully.`
3. مع نسخة بحالة `APPROVED`: `Error: ERROR: Rollback of 0026 refused: proposals or revisions still sit in PENDING_APPROVAL / APPROVED / EXPIRED / SUPERSEDED. Bring them back first (see the header of down.sql).`
4. بعد إعادتها: down 0026 → `Script executed successfully.` وفحص الكتالوج: `columnsLeft: 0`، لا نوع `CostSource`، لا الفهرس، لا تدفق ولا قاعدة ولا إعدادات؛ و`ProposalStatus` = `DRAFT,SENT,ACCEPTED,REJECTED,PENDING_APPROVAL,APPROVED,EXPIRED,SUPERSEDED` و`ApprovalDocument` يحتفظ بـ`PROPOSAL` (قيم الـenum تبقى كما هو موثّق).
5. `DELETE FROM "_prisma_migrations" WHERE migration_name IN ('0027_crm_proposals_backfill','0026_crm_proposals')` (كما في رأس 0024) ثم `migrate deploy`: طُبِّق الترحيلان من جديد (القيم موجودة فمرّ `IF NOT EXISTS`)، والكتالوج: 15 عموداً، `CostSource` موجود، الفهرس موجود، وتدفق `PROPOSAL` + إعدادات لكل المنشآت (55 منشأة منها ما أنشأته اختبارات التكامل)، وقاعدة واحدة (المنشأة المزروعة هي الوحيدة ذات دور `executive`).

**تجربة API دخانية** (نسخة مبنية من `dist` على المنفذ 4010، أُوقفت بعدها): الإقلاع سليم (بوابة الإقلاع تجد applier لـ`PROPOSAL`)؛ `cost-lookup` ← `GRN` بعمر يوم و`CATALOGUE`؛ مراجعة بتكلفة معدَّلة بلا سبب ← 400 `Cost override reason is required`؛ صلاحية ماضية ← 400؛ بسبب ← 201 والبنود `MANUAL` (`cost 450 / orig 320`) والأخرى `GRN`؛ `GET` ← `actions: ['SUBMIT']` و`submitTo: Executive management` و`settings {30,30}` و`validUntil` = اليوم + 30؛ `submit` ← `PENDING_APPROVAL` وطلب `PRP-… R1` بمبلغ 15500؛ `submit` ثانية ← 409؛ المندوب لا يرى الصف في صندوقه والرئيس يراه `canDecide: true`؛ قرار المندوب ← 403؛ اعتماد الرئيس ← `APPROVED`؛ `send` ← `SENT`؛ `reject` بسبب فارغ ← 400؛ مراجعة جديدة ← `[[1,SUPERSEDED],[2,DRAFT]]` والعرض `DRAFT`؛ `GET/PATCH /admin/settings` (قيمة خارج المدى ← 400، مفتاح الدمج ← 400 `Unknown setting key`، المندوب ← 403)؛ البحث بالرمز يعيد العرض؛ `/reference/enums` فيه 4 مصادر تكلفة. ثم شُغِّلت نسخة من `seed-demo.js` بأسماء فرص مختلفة مرتين: الأولى كشفت تحديد معدل الدخول (429 على `/auth/login` عند تسجيل دخول الرئيس لكل عرض)، فصُحِّح السكربت ليسجّل الدخول مرة لكل مستخدم؛ والثانية: المستشفى `رفع ← اعتماد ← إرسال ← قبول`، المصنع حتى الإرسال، المجمع حتى الانتظار.

## 4. الأدلة قبل/بعد

**قبل (قبل أي كود):** `npx jest proposal-pricing item-cost proposals.service proposal-expiry workflow.engine approval.service org-settings revision-pricing` ← `Test Suites: 8 failed, 8 total / Tests: 0 total`، 103 خطأ تجميع `ts-jest` متوقعة، منها:
- `proposal-pricing.spec.ts`: `Module '"@npi/shared"' has no exported member 'costAge'` / `'isStale'` / `'isValidityExpired'` / `'normalizeValidUntil'` / `'riyadhDayStart'` و`Cannot find module './proposal-pricing'`.
- `org-settings.service.spec.ts`: `Property 'PROPOSAL_VALIDITY_DAYS' does not exist on type ...` / `Property 'setEditable' does not exist on type 'OrgSettingsService'` / `Module './org-settings.service' has no exported member 'ORG_SETTING_EDITABLE'`.
- `workflow.engine.spec.ts`: `Property 'adopt' does not exist on type 'WorkflowEngine'` و`Argument of type '{ system: true; organizationId: string; }' is not assignable to parameter of type 'AuthUser'`.
- `approval.service.spec.ts`: `Argument of type '"PROPOSAL"' is not assignable to parameter of type 'ApprovalDocumentType'`.
- `item-cost.service.spec.ts` / `proposal-expiry.scheduler.spec.ts` / `proposals.service.spec.ts` / `revision-pricing.spec.ts`: وحدات وطرائق غير موجودة وعدد وسطاء البناء.
- التكامل: `npm run test:int -- proposal-lifecycle` ← `FAIL test/proposal-lifecycle.int-spec.ts`، 55 خطأ تجميع (`'validUntil' does not exist in type 'CreateRevisionDto'`، `Property 'submit' does not exist on type 'ProposalsService'`، `Property 'unitCost' does not exist on type ...`).

**بعد:**
- ملفات الوحدة الثمانية معاً: `Test Suites: 8 passed, 8 total / Tests: 165 passed, 165 total` (proposal-pricing 16، item-cost 6، proposals.service 46، proposal-expiry 6، workflow.engine 31، approval.service 32، org-settings 15، revision-pricing 13).
- `proposal-lifecycle.int-spec.ts`: 25 passed، وفشل أولاً مرة واحدة لسبب حقيقي كشفه الاختبار فقط: `SELECT pg_advisory_xact_lock(...)` عبر `$queryRaw` يفشل في Prisma (`Failed to deserialize column of type 'void'`) فاستُبدل بـ`$executeRaw`. يغطي بالمستخدمين الحقيقيين: التكلفة من استلام مقبول (95) لا من أمر USD الأحدث والأغلى (999) ولا من الكتالوج (80)، والكتالوج بلا تاريخ، وصفحة المسودة (`submitTo` والإعدادات)، التعديل اليدوي (400 بلا سبب، ثم `originalUnitCost/costSource MANUAL/السبب/من/متى`، واستبدال البنود لا إضافتها)، الرفع (طلب واحد خطوة `executive` بالإجمالي، تعيين الدور)، منع تعديل/نسخة/رفع ثانٍ أثناء الانتظار، رفض توقيع المندوب والمدير غير صاحب الدور، اعتماد الرئيس تحت اسمه (تاريخ المحرك `OPEN, SUBMIT, APPROVE` بفاعليه، وحدث `proposal.approved` بحمولته)، أزرار الصفحة `['REVISE','SEND']` فقط، الإرسال، نسخة جديدة (R2 مسودة، R1 `SUPERSEDED` بـ`supersededById` و`closedAt`، العرض `DRAFT`)، إعادة اعتماد R2 بتوقيع جديد (طلبان)، قبول النسخة الحالية المُرسلة فقط، رفض نسخة بعد القبول، إنشاء عقد من R2 (D-01) يكسب الفرصة؛ الرئيس يرفع عرضه بنفسه ← 409 بلا أي تغيير، وتفويضه هو لا يُحتسب (409)، وتفويض مؤقت من الرئيس يمكّن غيره من توقيع عرض المندوب؛ رفض المعتمِد ← `DRAFT` وسجل `RETURN` بالملاحظة وإعادة الرفع بسلسلة جديدة؛ الكنس الليلي (مُرسَل ومعتمد بصلاحية أمس ← `EXPIRED`، فاعل null، تعليق «automatically»، حدث، إشعار للكاتب، ومرة ثانية لا يكرر)، يوم الصلاحية نفسه صالح، والمسودة والمعلّق لا يُمسّان، و`send` بعد الانتهاء ← `EXPIRED` + 409 ثم نسخة جديدة من `EXPIRED`؛ رفعان متوازيان ← واحد ينجح وسلسلة واحدة؛ والقائمة.
- `tenant-isolation.int-spec.ts`: +9 اختبارات (`cost-lookup` لصنف منشأة أخرى ← `[]`، و`get/submit/send/rejectByCustomer/acceptRevision/addRevision/updateRevision` على عرضها ← 404 لا 403، ولا يظهر في القائمة، و`expireBySystem` لمنشأة أخرى ← `false` ولا تتغير حالته).
- `opportunity-stages.int-spec.ts` 20/20 كما كان (بعد نسخ تدفق `PROPOSAL` للمنشأة التجريبية، لأن `proposals.create` يفتح المثيل الآن).

## 5. الانحرافات عن العقد

1. **موضع دوال التسعير والتواريخ:** العقد يضع `proposal-pricing.ts` كله في المشترك، لكن `decimal.js` ليست حزمة قابلة للاستيراد في هذا المستودع (يضمّها Prisma باسم `Prisma.Decimal` فقط؛ لا `node_modules/decimal.js` ولا في القفل)، وإضافتها تعدّل `package-lock.json`. فصارت `priceRevision/sellingPrice` في `apps/api/src/common/proposal-pricing.ts`، أما ما لا يحتاج Decimal (`costAge/isStale` ودوال تواريخ الرياض) ففي المشترك `proposal-dates.ts`. الاختبار في `apps/api/src/common/` كما نصّ العقد (المشترك بلا jest).
2. **البذرة لا تستعمل `engine.adopt`:** `packages/db` لا يستورد من `apps/api`. بقي كود التبنّي المباشر في البذرة (وأُضيفت له مجموعة العروض)، ويستعمل `adopt` من النواة فقط `ensureInstance` في الخدمة، بينما الترحيل 0027 يتبنّى القائمة بـSQL. السلوك الثلاثة متطابق (حالة العرض، صف `ADOPT` بلا فاعل، إغلاق `ACCEPTED`).
3. **عدد الانتقالات 12 لا 11:** جدول §1-2 يسرد اثني عشر صفاً (يُحسب الانتهاء من حالتين والمراجعة من أربع)؛ نُفِّذت كلها، وهي في 0027 والبذرة معاً.
4. **الفاعل النظامي مقصور على `EXPIRE` بالإنفاذ:** العقد قال «لا يُستعمل إلا لـEXPIRE»؛ جعلتُ المحرك نفسه يرفض أي إجراء آخر منه (403) عبر `WF_SYSTEM_ACTIONS`، لا مجرد عرف في الخدمة.
5. **التنقية أوسع قليلاً:** لمن لا يحمل `finance.costs.view` يُخفى أيضاً `costSource` و`costDate` و`costAgeDays` و`costOverriddenAt/ById` (العقد سمّى `unitCost, originalUnitCost, costOverrideReason, subtotal, marginAmount, pricingScheme`)، لأن مصدر التكلفة وعمرها وكونها عُدِّلت تكشف الهامش.
6. **القبول يرفض نسخة انتهت ولم يكنسها الجدولُ بعد:** `acceptRevision` يُنفّذ `EXPIRE` بالفاعل النظامي ثم 409 `Proposal revision has expired` (العقد ذكر هذا لـ`send` فقط). بدونه يمكن قبول عرض صلاحيته أمس.
7. **ما يعيده `submit`:** `{ id, code, status, pendingApproval? }` لا صف العرض كاملاً كما يعيد `approvePo` (الصفحة تعيد التحميل).
8. **`escalationHours: 48` في قاعدة `PROPOSAL`** (الترحيل والبذرة) — العقد لم يذكره؛ هو قيمة بقية قواعد البذرة، والتصعيد ينبّه فقط ولا يوقّع.
9. **فحص «معتمِد آخر»:** يشترط أن يحمل صاحب الدور (أساسياً أو إضافياً) مفتاح `commercial.proposal.approve`، وللمفوَّض إليه أن يحمله هو بدوره الأساسي (لأن `decide` يطلبه)، وأن يكون المفوِّض صاحب الدور الأساسي المُعار (كما تقرأ `DelegationService.rolesFor`). يُفحص الدور الأول من الخطوات فقط (العقد: «للخطوة الأولى»).
10. **سيناريو التكامل (2) بإعطاء الرئيس `commercial.proposal.write`:** دور `executive` المزروع لا يحمل مفتاح كتابة العروض أصلاً (بلا مفاتيح كتابة حسب البذرة)، فالرئيس لا يستطيع رفع عرض بنفسه قبل أن يصل لفحص «معتمِد آخر» (403 من المحرك). الاختبار يمنحه المفتاح في الذاكرة فقط ويتحقق أن المنشأة المزروعة لديها الرئيس وحده في الدور (يفشل بصوت عالٍ إن تغيّر).
11. **البحث:** أُضيفت مجموعة `proposals` فعلاً (لم تكن العروض تُبحث)، بالرمز أو اسم الفرصة، وفي `global-search.tsx`.
12. **خارج القائمة لكن لازم:** (أ) `DOC_LABEL` في `approvals.tsx` لم يكن فيه `PURCHASE_REQUISITION` (صف طلب شراء في صندوق الاعتمادات كان سيسبب `TypeError`)، أُضيف مع `PROPOSAL`؛ (ب) `StatusBadge` لم يكن يعرف `PENDING_APPROVAL` أصلاً (العقد افترضه معروفاً)، أُضيف مع `EXPIRED/SUPERSEDED`؛ (ج) `costSources` في `/reference/enums`؛ (د) `GET /proposals/:id` يعيد زيادةً: `submitTo` (دور المعتمِد الذي ستسمّيه نافذة التأكيد)، `settings`، `currentRevisionNo`، `approval`، `pendingApproval`، `history`؛ و`actions` مفلترة من `APPROVE/RETURN/EXPIRE` (أزرار المصفوفة والساعة لا أزرار صفحة).
13. **قفل لكل عرض:** رفعان متوازيان كانا سينشئان سلسلتين (فحص `gate` «قراءة ثم كتابة»)، فتجري `submit` كلها تحت `pg_advisory_xact_lock` داخل معاملة تفاعلية (مهلة 60 ثانية). لم يطلبه العقد صراحة (اختبار التزامن §8-5 يتطلبه).
14. **`supersededById` بلا مفتاح أجنبي** (العقد أجاز ذلك)، و**`bomLines` الفارغة تُقبل في الإنشاء** (المسودة الفارغة) وتُرفض عند الرفع للاعتماد.
15. **اختبارات إضافية خارج §8:** ترحيل/تحرير الإعدادات (`org-settings.service.spec.ts`)، تنقية النسخ الجديدة في `revision-pricing.spec.ts`، وحالات `workflow.engine` للتبنّي المتكرر والفاعل النظامي لمنشأة بعينها.

## 6. سلوك ملحوظ

- **ما يعيده `engine.available` لكل حالة** (بحسب الصلاحية الحية): `DRAFT` ← `SUBMIT` (لحامل الكتابة، بشرط إجمالي > 0)؛ `PENDING_APPROVAL` ← `APPROVE` و`RETURN` لحامل مفتاح الاعتماد فقط، ولا شيء للمندوب؛ `APPROVED` ← `SEND` و`EXPIRE` و`REVISE`؛ `SENT` ← `ACCEPT` و`REJECT` و`EXPIRE` و`REVISE`؛ `REJECTED` و`EXPIRED` ← `REVISE`؛ `ACCEPTED` ← لا شيء (المثيل مُغلق). `GET /proposals/:id` يحذف `APPROVE/RETURN/EXPIRE` من `actions`، فيرى المندوب: مسودة `[SUBMIT]`، معتمد `[REVISE,SEND]`، مُرسَل `[ACCEPT,REJECT,REVISE]`.
- **تبنّي العروض القائمة:** الترحيل تبنّى 28 عرضاً (كل عروض القاعدة آنذاك) بحالتها، وبعد دورة `down/up` أُعيد تبنّي ما في القاعدة؛ العرض القديم الذي لا مثيل له (منشأة جاءت بعد الترحيل مثلاً) يُتبنّى كسلاً عند أول انتقال عبر `ensureInstance`. الحالات القديمة (`DRAFT/SENT/ACCEPTED/REJECTED`) كلها حالات في التدفق؛ `ACCEPTED` تُتبنّى مغلقة. **عرض قديم بنسخة `DRAFT` لم يعد يُقبل مباشرة:** عليه الرفع والاعتماد والإرسال أولاً. والنسخ القديمة لا تُعاد تسعيرها؛ تعديل مسودة قديمة يحوّلها إلى النمط الجديد (تُصبح لها تكلفة وصلاحية).
- **`NotificationType`:** لا enum؛ `Notification.type` عمود `String` حرّ (أمثلته في تعليق المخطط)، فاستُعمل `PROPOSAL_EXPIRED` لإشعار الكاتب بالانتهاء؛ والواجهة لا تُطابق النوع بأيقونة. إشعارات الاعتماد (`APPROVAL_PENDING/GRANTED/REJECTED`) تأتي من المصفوفة وروابطها `/approvals`.
- **`StatusBadge`:** كان يعرف `DRAFT/SENT/ACCEPTED/REJECTED/APPROVED` فقط؛ أُضيف `PENDING_APPROVAL` و`EXPIRED` و`SUPERSEDED`.
- **مسارات الاعتماد المتحقَّق منها** في `approvals.controller.ts`: `GET /approvals/inbox`، `GET /approvals/inbox/count`، `POST /approvals/:id/decide` بجسم `{ decision: 'APPROVE' | 'REJECT', note? }` (بلا `@RequirePermissions`: السلطة تُفحص داخل `decide`)، وهي ما يستعمله `seed-demo.js`.
- **صلاحيات المزروعين الفعلية:** بعد `db:seed` دور `sales` لا يحمل `commercial.proposal.approve` (البذرة تكتب صلاحيات الدور عند كل تشغيل، وترحيل 0021 كان منحه)، ودور `executive` يحمل `approve` ولا يحمل `commercial.proposal.write`، و`admin` يحملهما. أثر ذلك: الاعتماد الوحيد الممكن لعرض المندوب هو توقيع الرئيس أو مفوَّضه (وهذا المطلوب)، ولا يستطيع الرئيس إنشاء عروض (انظر §8).
- **ما يتأثر بتغيير معنى `unitPrice`:** تقرير الربحية (`finance/reports.service.ts`) وميزانية المشروع (`projects.service.ts`) يحسبان التكلفة من `Item.unitCost` للكتالوج لا من `BomLine.unitPrice`، فلا يتأثران؛ ولا شيء آخر في الشيفرة يقرأ `BomLine.unitPrice` سوى إجمالي العقد من `totalAmount`.
- **قيمة الصلاحية:** تُخزَّن منتصف ليل UTC ليوم الرياض المختار؛ تنتهي حين يبدأ يوم رياضي لاحق (يوم الصلاحية نفسه صالح كله)، ويعمل الكنس 01:30 بتوقيت الرياض.
- **أرقام لحظة التشغيل:** 55 تعريف تدفق (منشأة مزروعة + منشآت اختبارات التكامل التي سبقت الترحيل)، قاعدة `PROPOSAL` واحدة (المنشأة المزروعة)، و110 صفاً للإعدادات.

## 7. الحدود المعروفة

- **الواجهة لم تُفحص بصرياً في المتصفح** (لا لقطات ولا خادم واجهة): ما فُحص هو `tsc` وESLint وبناء Next الناجح وتجارب API الحية. ترتيب الأعمدة في RTL وألوان الشارات (الكهرماني للمعدَّل، أخضر/أصفر/رمادي للعمر) وشريط البانر والنموذج على الجوال بحاجة لمراجعتك (§10).
- **معاينة المجاميع في النموذج بأعداد عشرية عائمة** (عرض لحظي أثناء الكتابة فقط)؛ الخادم هو الذي يسعّر بـDecimal ويعيد الأرقام المعتمدة. المال المخزَّن والمُرسَل للمصفوفة والعقد كله Decimal.
- **القفل لكل عرض يحتجز اتصالاً من المجمّع** طوال `submit` (ثوانٍ). مع مجمّع الاتصالات الافتراضي (عدد الأنوية × 2 + 1) لا أثر عملي؛ لو فُرض `connection_limit=1` لتعطّل الرفع.
- **استعلام الاستلامات يقرأ كل صفوف الصنف التاريخية مرتبةً ويأخذ الأول في الذاكرة** (استعلام واحد للقائمة، لكن بلا `DISTINCT ON`)؛ مقبول لحجم الكتالوج الحالي، والترقية معروفة (مذكورة في تعليق الخدمة).
- **`costAgeDays` لقطة لحظة الكتابة** لا تُحسب عند العرض، فعمر سعر في نسخة قديمة يبقى كما كان وقت إعدادها.
- **لا مسار لتشغيل الكنس يدوياً** عبر HTTP؛ الجدولة الليلية فقط (وتُستدعى `sweep(now)` في الاختبارات). الإنذار «بقي أقل من 7 أيام» في القائمة يُحسب من تاريخ متصفح المستخدم المحلي.
- **على قواعد القائمة** (هذه المحلية مثلاً) قيم `ProposalStatus` الأربع الجديدة مضافة في آخر الـenum (الترتيب `DRAFT,SENT,ACCEPTED,REJECTED,PENDING_APPROVAL,...`) لأنها أُضيفت قبل أن أُضيف تحديد المواضع في 0026؛ الترحيل المعدَّل ينتج الترتيب الصحيح على قاعدة جديدة (جُرِّب على نوع مؤقت). الأثر الوحيد هو `ORDER BY status`، ولا شيء في الكود يعتمد عليه.
- **إشعارات نتيجة الاعتماد** (للرافع) تفتح `/approvals` لا صفحة العرض (سلوك المصفوفة العام).
- **اختبارات التكامل تترك** منشأة الجار وعرضها (نمط `tenant-isolation` القائم)؛ أما `proposal-lifecycle` فينظّف كل ما أنشأه (العروض، الطلبات، المثيلات، الفرص، الأصناف، المورّد، العميل، الأوامر والاستلامات).
- لم تُنفَّذ لوحة تحكم ولا بدائل دائمة ولا حدّ مالي في الكود (الحد صف في المصفوفة، يُعدَّل من الواجهة).

## 8. ما يحتاج قرار المراجع

1. **الرئيس التنفيذي لا يملك `commercial.proposal.write`:** في البذرة (وفي الخادم الحي إن كان دوره كذلك) لا يستطيع إنشاء عرض ولا رفعه، فسيناريو §11-2 («عرض ينشئه الرئيس بنفسه») لا يحدث إلا إن مُنح المفتاح. هل يبقى كذلك (مفاتيح الإدارة العليا قراءة واعتماد فقط)، أم يُمنح الكتابة فيصبح الفحص «لا معتمِد آخر» هو الحارس؟ الفحص مُنفَّذ ومختبَر في الحالتين.
2. **دور `sales` بلا `commercial.proposal.approve` بعد البذرة** (العقد §0 يقول إنه يحمله من 0021). أبقيتُ البذرة كما هي لأن المصفوفة توجّه التوقيع للرئيس على أي حال؛ لكن لو أردتَ أن يعتمد المندوب أعلى حدّ ما (حين يُرفع الحد من المصفوفة) فلا بد من المفتاح. هل تُعدَّل البذرة أم يبقى؟
3. **قبول نسخة انتهت ولم يُكنس بعد → 409** (انحراف 6): تأكيد؟
4. **`escalationHours = 48` على قاعدة العروض** (انحراف 8): هل تريد تصعيداً على العروض أصلاً، أم `NULL`؟
5. **عرض قديم بمسودة لا يُقبل مباشرة** (يمرّ بالرفع والاعتماد): مقصود حسب §1-5 ولكنه تغيير سلوك على عروض المسودات القديمة الموجودة؛ هل تُرحَّل العروض القائمة بحالات أخرى؟
6. **التنقية الأوسع** (انحراف 5): من لا يحمل `finance.costs.view` لا يرى مصدر التكلفة ولا عمرها ولا أن تكلفة عُدِّلت؛ هل يكفي المعتمِد/المندوب بدون المفتاح بسعر البيع؟
7. **خوادم التطوير أوقفتُها:** `nest start --watch` وعمليته المبنية `apps\api\dist\main` (PID 27068، تقفل محرك Prisma فيفشل `prisma generate` بـ`EPERM`) وخادم `next dev` (يستعمل مجلد `.next` نفسه الذي يكتب فيه `next build`). كانت تعمل من هذا الـworktree منذ مساء أمس على المنافذ 4000 و3000. أعد تشغيلها (`preview_start`) قبل المراجعة الحية. وأعدتُ بناء `apps/api/dist` و`.next`.
8. **تشغيل `seed-demo.js`:** شغّلتُ نسخة منه (بأسماء فرص `T4`/`T5`) مرتين على API المنفذ 4010 للتحقق، فأنشأ الجزء غير الـidempotent منه (أوامر الشراء، المشروع، مستخلص الباطن، أوامر العمل، شروط PPA) بيانات إضافية في القاعدة المحلية: `PO-00023…26` وفواتير موردين ومدفوعات وعقد باطن (نقلتُها من مورد اختباري تسرّب من اختبار تكامل إلى `VEN-00001` وحذفتُ المورد)، وحذفتُ فرص/عروض/طلبات `T4`/`T5` و`SMOKE` وإشعاراتها. لم أحذف الأوامر والمستخلصات وأوامر العمل لأنها مرحَّلة محاسبياً. المطلوب منك: هل يكفي، أم تنظّف القاعدة قبل التشغيل الحي الوحيد للسكربت؟
9. **الواجهة:** لم تُشاهَد. المراجعة الحية (§10 من العقد: المندوب يرى شارة العمر والتكلفة المعدَّلة المميَّزة، والرئيس يرى البنود المميَّزة قبل التوقيع) هي أول اختبار لها.

## git status --short

```
 M apps/api/src/common/approval.service.spec.ts
 M apps/api/src/common/org-settings.service.ts
 M apps/api/src/common/workflow/workflow.engine.spec.ts
 M apps/api/src/common/workflow/workflow.engine.ts
 M apps/api/src/modules/admin/admin.controller.ts
 M apps/api/src/modules/commercial/commercial.module.ts
 M apps/api/src/modules/commercial/dto.ts
 M apps/api/src/modules/commercial/proposals.controller.ts
 M apps/api/src/modules/commercial/proposals.service.spec.ts
 M apps/api/src/modules/commercial/proposals.service.ts
 M apps/api/src/modules/commercial/revision-pricing.spec.ts
 M apps/api/src/modules/commercial/revision-pricing.ts
 M apps/api/src/modules/reference/reference.controller.ts
 M apps/api/src/modules/search/search.service.ts
 M apps/api/test/opportunity-stages.int-spec.ts
 M apps/api/test/tenant-isolation.int-spec.ts
 M apps/web/src/app/(app)/admin/page.tsx
 M apps/web/src/app/(app)/proposals/[id]/page.tsx
 M apps/web/src/app/(app)/proposals/page.tsx
 M apps/web/src/components/approvals.tsx
 M apps/web/src/components/global-search.tsx
 M apps/web/src/components/ui.tsx
 M apps/web/src/lib/errors.ts
 M apps/web/src/lib/messages.ts
 M apps/web/src/lib/useEnums.ts
 M packages/db/prisma/schema.prisma
 M packages/db/prisma/seed.ts
 M packages/shared/src/approvals.ts
 M packages/shared/src/enums.ts
 M packages/shared/src/index.ts
 M packages/shared/src/permissions.ts
 M packages/shared/src/workflow.ts
 M scripts/seed-demo.js
?? apps/api/src/common/org-settings.service.spec.ts
?? apps/api/src/common/proposal-pricing.spec.ts
?? apps/api/src/common/proposal-pricing.ts
?? apps/api/src/modules/commercial/item-cost.service.spec.ts
?? apps/api/src/modules/commercial/item-cost.service.ts
?? apps/api/src/modules/commercial/proposal-expiry.scheduler.spec.ts
?? apps/api/src/modules/commercial/proposal-expiry.scheduler.ts
?? apps/api/test/proposal-lifecycle.int-spec.ts
?? apps/api/test/support/
?? apps/web/src/components/proposal-settings.tsx
?? docs/crm-phase-1/step-4-agent-report.md
?? docs/crm-phase-1/step-4-proposals-contract.md
?? packages/db/prisma/migrations/0026_crm_proposals/
?? packages/db/prisma/migrations/0027_crm_proposals_backfill/
?? packages/shared/src/proposal-dates.ts
```


(التقطت بعد كتابة هذا التقرير مباشرة؛ التقرير نفسه ظاهر في القائمة.)
