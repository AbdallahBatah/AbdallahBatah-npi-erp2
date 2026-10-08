# الخطوة 2 — سجل العميل الموحّد والدمج (القسم 4.1): العقد الملزم للوكيل المنفّذ

> **معتمد من إياد 2026-10-06** (قرارات القسم 10 الخمسة كلها «نعم»). كُتب بعد التزام الخطوة 1 = 774ec57؛ نُفِّذ في الالتزام التالي لهذا الملف. مراجعة القسم 9 موثقة في `screenshots/step-2-0[1-4]-*.jpg`.
> مجلد العمل: `C:\dev\npi-erp-crm` (worktree على `feature/crm-phase-1`). القاعدة: إضافة فقط؛ لا حذف ولا تعديل عمود/جدول قائم؛ جدول العملاء القائم `Customer` هو السجل الوحيد (لا جدول عملاء ثانٍ).
> نص الوثيقة §4.1 (المرجع الملزم): مفتاح فريد = السجل التجاري أو الرقم الضريبي للمنشآت، والجوال للأفراد؛ تحذير فوري عند تشابه الاسم مع عرض السجل المشابه قبل الحفظ؛ جهات اتصال متعددة؛ صفحة واحدة تجمع الفرص والعروض والعقود والمشاريع والمستخلصات وسجل التواصل؛ دمج المكررات مرة واحدة قبل الإطلاق بأداة تنقل كل المستندات المرتبطة إلى السجل الباقي.
> أمر التنفيذ (الخطوة 2): إنشاء عميل بسجل تجاري/رقم ضريبي/جوال موجود يُرفض؛ تشابه الاسم يُظهر تحذيراً؛ أداة الدمج تعرض قائمة المكررات المقترحة **ولا تدمج شيئاً قبل موافقة إياد على القائمة**؛ نسخة احتياطية قبل الدمج.

## 0. حقائق الكود الحالي (مرجع الوكيل)
- `Customer` في `packages/db/prisma/schema.prisma:354-377`: `id, organizationId, code (CUS-xxxxx), nameAr, nameEn, customerType(RESIDENTIAL|CI|UTILITY|GOVERNMENT), vatNumber?, crNumber?, creditTermsDays, phone?, email?, createdAt, updatedAt`. التفرّد فقط `(organizationId, code)`. لا حالة، لا حقل دمج، لا جوال مستقل.
- المفاتيح الأجنبية إلى العميل **أربعة فقط**: `Lead.customerId?` (:394)، `Opportunity.customerId` (:411)، `Contract.customerId` (:556)، `Invoice.customerId` (:650). العروض والمشاريع والمستخلصات والـPPA وأوامر العمل تصل للعميل عبر الفرصة/العقد. لا فهرس على `customerId` في `Contract` و`Invoice`.
- الخدمة `apps/api/src/modules/crm/customers.service.ts`: `list/get/create/update`؛ `update` خارج معاملة وتدقيقه غير ذرّي. `leads.service.ts:120-183` (`convert`) ينشئ عميلاً بلا تدقيق `Customer CREATE` وبلا فحص أن `customerId` الممرَّر يخص المنشأة.
- لا أداة تطبيع عربي في المستودع؛ لا `pg_trgm`؛ البحث العام `modules/search/search.service.ts` يستعلم `contains` حياً ويوجّه العميل إلى `/customers?q=`.
- `AttachmentEntity` = `CONTRACT, INVOICE, PROJECT, WORK_ORDER` (:1845)؛ خريطة الصلاحيات في `platform/attachments.service.ts:32-37,61-69`؛ اتحاد الأنواع في `apps/web/src/components/attachments.tsx:33-38`.
- الواجهة: `apps/web/src/app/(app)/customers/page.tsx` قائمة + نافذة إنشاء فقط، الصفوف غير قابلة للنقر، لا `customers/[id]`. نمط التبويبات في `invoices/[id]/page.tsx:80,342-350,528`.
- التدقيق: `AuditService.record({organizationId, actorId, entityType, entityId, action, before?, after?}, tx?)`. الصندوق الصادر: `OutboxService.emit(tx, {organizationId, eventCode, payload})` (المعاملة إلزامية). أكواد الأحداث في `packages/shared/src/workflow.ts:128-136`.
- الترجمة: مفاتيح `cust.*` في `apps/web/src/lib/messages.ts:192-199` (ar) و`:1127-1134` (en). أخطاء الخادم تُترجم بأنماط في `apps/web/src/lib/errors.ts:9-135`؛ **404 يُعرض نصاً عاماً دائماً** فلا تستعمله لرسائل مخصصة. P2002 → 409 `DUPLICATE` في `common/global-exception.filter.ts:33-58`.
- النسخ الاحتياطي: `deploy/backup.sh` (pg_dump بصيغة custom + تحقق `pg_restore --list`) على الخادم الحي فقط؛ لا مساعد داخل التطبيق.
- اختبارات التكامل `apps/api/test/*.int-spec.ts` تبني الخدمات يدوياً بلا Nest (`tenant-isolation.int-spec.ts:28-39`)، وترفض `DATABASE_URL` غير محلي، و`AuthUser` يُبنى بـ`permissions:['*']`.
- البذرة: `CUS-00001` «مصنع الرياض للصناعات» (`seed.ts:363-377`) و`LEAD-00001` بنفس الاسم والجوال (`:411-427`) = سيناريو شبه-مكرر جاهز.

## 1. قاعدة البيانات — ترحيلان
### 1-أ `0022_crm_unified_customer` (إضافة فقط + `down.sql` بعرف 0021)
- enum جديد `CustomerEntityKind { COMPANY, INDIVIDUAL }`.
- أعمدة جديدة على `Customer` (كلها nullable أو بقيمة افتراضية): `entityKind CustomerEntityKind @default(COMPANY)`، `mobile String?` (بصيغة موحّدة `+9665xxxxxxxx`)، `nameNormalized String?` (الاسم العربي بعد التطبيع، للمطابقة)، `mergedIntoId String?` + علاقة ذاتية `mergedInto Customer? @relation("CustomerMerge")` و`mergedFrom Customer[]`، `mergedAt DateTime?`. فهارس **غير فريدة**: `(organizationId, crNumber)`, `(organizationId, vatNumber)`, `(organizationId, mobile)`, `(organizationId, nameNormalized)`, `(mergedIntoId)`.
- فهارس على `Contract(customerId)` و`Invoice(customerId)` (إضافة فهرس فقط؛ يلزم للدمج).
- جدول `CustomerContact { id, organizationId, customerId, name, title?, phone?, mobile?, email?, isPrimary Boolean @default(false), notes?, createdAt, updatedAt }` فهرس `(organizationId, customerId)`؛ `onDelete: Cascade` على العميل.
- جدول `CustomerMergeLog { id, organizationId, survivorId, mergedId, movedJson Json (عدد الصفوف المنقولة لكل جدول)، mergedSnapshotJson Json (العميل المدمج كاملاً قبل الدمج)، backupRef String (اسم ملف النسخة الاحتياطية الذي أدخله المدير)، performedById, performedAt }` فهرس `(organizationId, survivorId)`.
- جدول `OrgSetting { id, organizationId, key, valueJson Json, updatedAt }` بتفرّد `(organizationId, key)` — مقرر في الخطة ويلزم هنا لعتبة التشابه ومفتاح تفعيل الدمج، وستستعمله الخطوتان 4 و5.
- قيمة enum `AttachmentEntity.CUSTOMER` (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`، مع تعليق في down.sql أن Postgres لا يحذف قيم enum — عرف 0020).
- تعبئة بيانات داخل الترحيل: `nameNormalized` لكل عميل قائم بدالة SQL مكافئة للتطبيع؛ الوكيل يثبت التطابق الحرفي مع دالة TypeScript باختبار يقارن مخرجَي SQL وTS على عيّنة أسماء. `mobile` يُستنتج من `phone` القائم **إن** طابق نمط جوال سعودي (`05xxxxxxxx` / `+9665xxxxxxxx` / `9665xxxxxxxx`)، وإلا يبقى فارغاً و`phone` كما هو.
- `down.sql`: حذف الجداول الثلاثة، حذف الأعمدة والفهارس الجديدة من `Customer`/`Contract`/`Invoice`، تعليق صريح عن enum.

### 1-ب `0023_crm_customer_unique_keys` (ملف منفصل، يُطبَّق بعد الدمج)
- فهارس فريدة **جزئية**: `(organizationId, crNumber) WHERE "crNumber" IS NOT NULL AND "mergedIntoId" IS NULL`، ومثلها `vatNumber` و`mobile`.
- **ترتيب النشر على الخادم الحي (قرار يُعرض على إياد):** إصدار 2-أ (0022 + أداة الدمج) → إحصاء المكررات → موافقة إياد على القائمة → نسخة احتياطية → الدمج → إصدار 2-ب (0023). إن بقيت مكررات فسيفشل 0023 **عمداً** (fail-closed) ويبقى الإصدار السابق يخدم (deploy.sh يرحّل قبل التبديل). محلياً يُطبَّق الاثنان فوراً (لا مكررات حقيقية).

## 2. المشترك (`packages/shared/src`)
- ملف جديد `arabic.ts`: `normalizeArabicName(s)` = إزالة التشكيل والتطويل، توحيد `أإآ→ا`، `ة→ه`، `ى→ي`، `ؤ→و`، `ئ→ي`، إزالة «ال» التعريف من بداية كل كلمة، توحيد المسافات، lowercase للاتيني، إزالة علامات الترقيم؛ `stripLegalForm(s)` تزيل كلمات الكيان القانوني للمقارنة فقط (شركة، مؤسسة، مجموعة، المحدودة، ش.م.م، ذ.م.م، للتجارة، للمقاولات، Co, Ltd, LLC, Est, Company) **بدون** إزالة كلمات النشاط (مصنع، مكتب، مستودع)؛ `nameSimilarity(a,b)` = معامل Dice على ثنائيات الأحرف (bigrams) للنصين المطبّعين بعد `stripLegalForm` ∈ [0,1]؛ `normalizeSaudiMobile(s)` → `+9665xxxxxxxx` أو `null` إن لم يطابق.
- `permissions.ts`: مفتاح جديد `CUSTOMER_MERGE='crm.customer.merge'` (action: `special`، screenAr «العملاء»، يظهر في قسم «صلاحيات خاصة» بشبكة الخطوة 1). يُمنح في seed لـ`admin` (تلقائياً عبر ALL) و`executive` فقط.
- `workflow.ts`: حدث واحد `customer.merged` مع عنوان في `WF_EVENT_LABELS`. رفض التكرار يُسجَّل تدقيقاً لا حدثاً.
- `enums.ts`: `CUSTOMER_ENTITY_KINDS` مع عناوين عربية/إنجليزية.
- خدمة `common/org-settings.service.ts`: `get<T>(organizationId, key, defaultValue)` و`set(...)` مع تدقيق؛ مفتاحان في هذه الخطوة: `crm.customer.similarityThreshold` (افتراضي `0.8`) و`crm.customer.mergeEnabled` (افتراضي `false`). تبويب `/admin` للإعدادات يُؤجَّل إلى الخطوة 4 (أول قيمة يعدّلها المستخدم فعلياً).

## 3. الخدمة (`modules/crm/customers.service.ts` + ملفات جديدة)
- **فحص التكرار** `assertNoDuplicateKeys(tx, org, {crNumber, vatNumber, mobile}, excludeId?)`: يبحث بين العملاء غير المدمجين؛ عند التطابق يرمي `ConflictException` برسالة إنجليزية ثابتة تبدأ بـ`Duplicate customer key:` وتتضمن `{ code: 'CUSTOMER_DUPLICATE', field, existing: {id, code, nameAr, nameEn} }`. يُستدعى من `create` و`update` و`leads.convert` (كلها داخل المعاملة).
- قواعد الإلزام **للسجلات الجديدة فقط**: `INDIVIDUAL` يلزمه `mobile`؛ `COMPANY` يلزمه `crNumber` **أو** `vatNumber`. السجلات القائمة الناقصة تبقى قابلة للتعديل دون إجبار (تحذير في الواجهة لا رفض) — افتراض يُعرض على إياد.
- `GET /customers/similar?name=&excludeId=`: يعيد حتى 5 عملاء غير مدمجين بتشابه ≥ العتبة مرتبين تنازلياً مع `score`. التنفيذ: جلب `id, code, nameAr, nameEn, nameNormalized` لعملاء المنشأة (حد 5000) والحساب في الذاكرة — كافٍ للحجم الحالي، ويُوثَّق أن `pg_trgm` بديل مستقبلي.
- `list` يستبعد المدمجين افتراضياً (`?includeMerged=1` لمن يحمل `crm.customer.merge`)، ويبحث أيضاً في `mobile` و`crNumber` و`vatNumber`. `get(:id)` لعميل مدمج يعيد السجل مع `mergedInto {id, code, nameAr, nameEn}` لتعيد الواجهة التوجيه.
- `update` يصبح داخل `$transaction` مع تدقيق ذرّي (إصلاح الفجوة القائمة؛ مسموح لأن المسار يُلمس مباشرة).
- `leads.convert`/`leads.create`: فحص أن `customerId` يخص المنشأة (404 بنفس أسلوب `opportunities.service.ts:49-53`) + تدقيق `Customer CREATE` + فحص التكرار؛ عند التكرار يرمي الـ409 نفسه ليختار المستخدم العميل القائم.
- **جهات الاتصال** `customer-contacts.service.ts`: `list/create/update/remove` تحت `/customers/:id/contacts[/:contactId]`، صلاحيات `crm.customer.read/write`، `isPrimary` واحد فقط لكل عميل (يُلغى من الآخرين داخل المعاملة)، حذف فعلي مع تدقيق `DELETE` بكيان `CustomerContact` (ليست مستنداً مالياً).
- **الدمج** `customer-merge.service.ts`:
  - `GET /customers/duplicates` (صلاحية `crm.customer.merge`): مجموعات مقترحة: (أ) تطابق تام لمفتاح (CR/VAT/mobile المطبّع)، (ب) تشابه اسم ≥ العتبة. لكل مجموعة: الأعضاء مع عدد المستندات المرتبطة لكل منهم (leads/opportunities/contracts/invoices/contacts) و`suggestedSurvivorId` = من يملك مستندات أكثر، وعند التساوي الأقدم إنشاءً. القائمة **عرض فقط**.
  - `POST /customers/merge` body `{survivorId, mergedIds[], backupRef}`: يُرفض بـ403 ورسالة `Customer merge is disabled` ما لم يكن `crm.customer.mergeEnabled = true`. `backupRef` نص إلزامي ≥ 8 أحرف = اسم ملف النسخة الاحتياطية؛ الخادم لا يأخذ النسخة بنفسه، والواجهة تطلب كتابته صراحةً. داخل `$transaction` واحدة لكل عميل مُدمَج: رفض إن كان أي طرف مدمجاً سابقاً (409) أو خارج المنشأة (404) أو الباقي ضمن المدمجين (400)؛ `updateMany` على الجداول الأربعة (`Lead, Opportunity, Contract, Invoice`) + `CustomerContact` + `Attachment(entityType=CUSTOMER)` من المدمج إلى الباقي؛ تعبئة حقول الباقي **الفارغة فقط** من المدمج (`vatNumber, crNumber, mobile, phone, email, nameEn`) — لا استبدال؛ `creditTermsDays` يبقى للباقي؛ وضع `mergedIntoId/mergedAt` على المدمج **دون حذفه** (رمزه `CUS-xxxxx` يبقى محجوزاً)؛ صف `CustomerMergeLog`؛ تدقيق `MERGE` على الاثنين (`before` = لقطة المدمج، `after` = الباقي بعد التعبئة)؛ حدث `customer.merged` عبر `OutboxService.emit`.
  - **ملاحظة قانونية تُفحص**: الفواتير الصادرة (ZATCA) تحتفظ بمستنداتها الإلكترونية في `EInvoiceDocument`؛ الوكيل يتحقق أن XML/الهاش مخزَّن ولا يُعاد توليده بعد نقل `customerId`، ويذكر النتيجة في تقريره. المكرران هما الكيان القانوني نفسه، فنقل المفتاح لا يغيّر المشتري.
  - لا «فك دمج» آلي؛ التراجع = الاستعادة من النسخة الاحتياطية (موثَّق في الواجهة قبل التأكيد).
- **إحصاء المكررات على الخادم الحي** قبل أي دمج: ملف `docs/crm-phase-1/customer-duplicates-census.sql` (قراءة فقط) بالاستعلامات نفسها (CR/VAT/جوال مطبّع/اسم مطبّع)، يُنفَّذ عبر SSH **بموافقة إياد**، ونتيجته تُعرض عليه كجدول عربي قبل الإصدار 2-ب.

## 4. المرفقات والبحث
- `AttachmentEntity.CUSTOMER` في enum + `ENTITY_READ_PERMISSION` (`crm.customer.read`) + `assertEntityExists` + اتحاد الأنواع في `attachments.tsx`.
- `search.service.ts`: العملاء يُبحثون أيضاً بـ`mobile`، يُستبعد المدمجون، و`href` يصبح `/customers/{id}`.

## 5. الواجهة (`apps/web`)
- `/customers`: الصفوف تنقل إلى `/customers/[id]`؛ عمود الجوال بدل الهاتف عند وجوده؛ شارة «مدمج» عند `includeMerged`؛ نافذة الإنشاء تكسب: نوع الكيان (منشأة/فرد)، الجوال، شروط الائتمان (`creditTermsDays` كان ناقصاً)، و**تحذير التشابه الفوري**: عند كتابة الاسم (debounce 350ms كالبحث) يُستدعى `/customers/similar` وتُعرض المطابقات ببطاقة تحذيرية تضم الرمز والاسم ورابط «فتح السجل القائم»، والزر «إنشاء رغم التشابه» يبقى متاحاً (الوثيقة: تحذير لا منع). رفض المفتاح المكرر (409) يُترجم: «يوجد عميل بنفس {السجل التجاري|الرقم الضريبي|الجوال}: CUS-xxxxx — اسم العميل» مع رابط.
- صفحة جديدة `/customers/[id]`: ترويسة (الاسم، النوع، الكيان، المفاتيح، شروط الائتمان، زر تعديل بنافذة `Modal` نفسها)؛ إن كان مدمجاً → شريط «دُمج هذا السجل في CUS-xxxxx» ورابط. تبويبات `Tabs`: **جهات الاتصال** (جدول + إنشاء/تعديل/حذف + «أساسي») | **الفرص** | **العروض** (عبر الفرص) | **العقود** | **المشاريع** (عبر العقود) | **المستخلصات** (عبر المشاريع، عرض فقط) | **المرفقات** (`AttachmentsCard entityType="CUSTOMER"`). تبويبا «سجل التواصل» و«المهام» يُضافان في الخطوة 5. البيانات من مسار واحد `GET /customers/:id/overview` يعيد العدّادات والقوائم (حد 50 لكل تبويب) بدل سبع استدعاءات؛ كل قائمة تخضع لصلاحية القراءة الخاصة بها (العروض لمن يملك `commercial.proposal.read` وهكذا) وتُحذف من الاستجابة عند غيابها.
- `/admin` تبويب جديد «دمج العملاء» (يظهر لمن يحمل `crm.customer.merge`): قائمة المجموعات المقترحة، اختيار الباقي داخل كل مجموعة، زر «دمج» يفتح تأكيداً يطلب كتابة اسم ملف النسخة الاحتياطية ويشرح أن التراجع بالاستعادة فقط. **يُسلَّم مع الدمج معطَّلاً خلف إعداد `crm.customer.mergeEnabled=false`** حتى يوافق إياد على القائمة (الوكيل يسلّم الأداة، وإياد يقرر التشغيل). في الواجهة يظهر شريط «الدمج معطَّل حتى اعتماد القائمة».
- مفاتيح i18n جديدة بالعربية والإنجليزية تحت `cust.*` (مثلاً `cust.entityKind`, `cust.mobile`, `cust.similar.title`, `cust.similar.createAnyway`, `cust.merged.banner`, `cust.contacts.*`, `cust.merge.*`, `cust.tab.*`)، وأنماط `errors.ts` لـ`Duplicate customer key` و`Customer already merged` و`Customer merge is disabled`.

## 6. الزرع والسكربتات
- `seed.ts`: `CUS-00001` يكسب `entityKind: COMPANY`, `crNumber: '1010000001'`, `mobile` من هاتفه؛ `OrgSetting` بالمفتاحين؛ صلاحية `crm.customer.merge` لـ`executive`. قائمة الصلاحيات المحلية في `seed.ts:17-33` تُحدَّث.
- `scripts/seed-demo.js` يبقى كما هو (يمر عبر API فيخضع للفحص نفسه؛ إن فشل بسبب التكرار يُصحَّح بإضافة مفاتيح مميزة).

## 7. الاختبارات (قبل الكود، بأدلة قبل/بعد)
- وحدة `packages/shared/src/arabic.spec.ts`: «شركة الرياض للصناعات» ≈ «مصنع الرياض للصناعات» (≥ 0.8)، «أحمد العلي» = «احمد العلى» (= 1.0)، «شركة النور» ≠ «شركة النورس للمقاولات» (< 0.8 يوثَّق الرقم)، جوال `0501234567` → `+966501234567`، `011...` → `null`.
- وحدة لـ`customers.service` (رفض التكرار في create/update/convert، الإلزام للجديد فقط) ولـ`customer-merge.service` (رفض الدمج والإعداد معطَّل).
- تكامل `apps/api/test/customer-merge.int-spec.ts`: إنشاء عميلين ومستندات على كلٍّ (lead, opportunity, contract, invoice, contact, attachment) → الدمج ينقلها كلها ويترك المدمج موسوماً ويملأ الحقول الفارغة فقط؛ محاولة دمج عميل من منشأة أخرى → 404؛ دمج مدمَج سابقاً → 409؛ `backupRef` فارغ → 400؛ الفهرس الجزئي 0023 يرفض إدخال CR مكرر (P2002 → 409).
- `tenant-isolation.int-spec.ts`: إضافة حالة `GET /customers/similar` لا يرى عملاء منشأة أخرى.

## 8. القبول قبل تسليم الوكيل
`npm run typecheck && npm run lint && npm test` خضراء، `npm run db:deploy && npm run db:seed` بلا أخطاء، `npm run test:int` خضراء على القاعدة المحلية، `psql -f down.sql` لكل من 0023 ثم 0022 ثم إعادة الترحيل تعمل (يثبتها). التقرير يذكر كل ملف مُعدَّل، نتيجة فحص `EInvoiceDocument`، وقيم التشابه الفعلية لأمثلة الاختبار.

## 9. مراجعة النموذج الرئيسي (قبل العرض على إياد)
تشغيل API وWeb من الـworktree والتحقق بمدخلات حقيقية: (1) إنشاء «شركة الرياض للصناعات» يُظهر تحذير التشابه مع CUS-00001؛ (2) إنشاء عميل بالرقم الضريبي `310000000000003` يُرفض برسالة عربية تحمل CUS-00001؛ (3) صفحة CUS-00001 تعرض التبويبات وجهة اتصال جديدة؛ (4) تبويب «دمج العملاء» يعرض مجموعة البذرة (العميل + العميل المنشأ من LEAD-00001) **دون** تنفيذ الدمج. لقطات في `docs/crm-phase-1/screenshots/step-2-*`. ثم العرض على إياد بلغة غير برمجية مع قائمة المكررات المقترحة، وانتظار موافقته على القائمة قبل أي دمج وعلى الخطوة قبل الخطوة 3.

## 10. ما يُعرض على إياد للقرار (مع التوصية)
1. ترتيب الإصدارين 2-أ/2-ب على الخادم الحي (البند 1-ب) — **التوصية: نعم**.
2. الإلزام (جوال للفرد، سجل أو ضريبي للمنشأة) للسجلات الجديدة فقط، وتحذير للقائمة — **التوصية: نعم**.
3. إنشاء جدول الإعدادات `OrgSetting` الآن مع عتبة التشابه 0.8 — **التوصية: نعم**.
4. الدمج يُسلَّم معطَّلاً خلف إعداد حتى الموافقة على القائمة — **التوصية: نعم**.
5. حذف جهة الاتصال حذف فعلي مع تدقيق (لا أرشفة) — **التوصية: نعم**.
