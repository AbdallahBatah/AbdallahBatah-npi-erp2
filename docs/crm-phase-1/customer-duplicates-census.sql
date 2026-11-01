-- ============================================================================
-- إحصاء العملاء المكررين — الخطوة 2 من المرحلة الأولى لإدارة علاقات العملاء
-- ============================================================================
--
-- الغرض: عدّ العملاء المكررين على الخادم الحي *قبل* أي دمج، وعرض النتيجة على
-- إياد جدولاً عربياً. الملف للقراءة فقط: يعمل داخل معاملة READ ONLY تُلغى في
-- النهاية، فلا يستطيع تعديل صف واحد حتى لو كُتب فيه خطأ.
--
-- شرط التشغيل: أن يكون الترحيل 0022 قد طُبّق (يضيف الأعمدة mobile و
-- nameNormalized و mergedIntoId). لا يحتاج 0023 ولا أداة الدمج.
--
-- كيف يُشغَّل (من جهاز إياد في Git Bash، وبموافقته فقط). الملف لا يوجد على
-- الخادم لأن deploy/pack.ps1 يستثني مجلد docs من الحزمة، فيُمرَّر من الجهاز عبر
-- المدخل القياسي لـ ssh، وتُحفظ النتيجة محلياً في census-live.txt (غير متتبَّع):
--
--   cd /c/dev/npi-erp-crm && ssh root@SERVER_IP "cd /opt/npi-erp && \
--     docker compose -f docker-compose.prod.yml --env-file deploy/.env exec -T postgres \
--     psql -U npi -d npi_erp -v ON_ERROR_STOP=1" \
--     < docs/crm-phase-1/customer-duplicates-census.sql > census-live.txt 2>&1
--
-- (اسم الخدمة postgres والمستخدم npi وقاعدة البيانات npi_erp كما في
-- docker-compose.prod.yml. لا يصلح من PowerShell 5.1 لأنه لا يدعم «<» ويُفسد
-- الترميز العربي عند التمرير.)
--
-- كيف تُقرأ النتائج:
--   * القسم 0 صورة عامة. الأقسام 1 إلى 3 هي المفاتيح الفريدة: كل صف فيها
--     يعني أن الترحيل 0023 سيفشل عمداً حتى يُدمج المكرر. إن كانت الأقسام 1 إلى 3
--     فارغة فالمفاتيح نظيفة.
--   * القسم 4 تطابق الاسم تطابقاً حرفياً بعد التطبيع وإزالة كلمات الكيان
--     القانوني. هو تقريب بسيط: التشابه الجزئي (الذي تحسبه أداة الدمج بمعامل
--     Dice) لا يمكن حسابه في SQL لأن pg_trgm غير مثبّتة. قائمة التشابه الكاملة
--     تأتي من الأداة نفسها (GET /customers/duplicates) وهي عرض فقط.
--   * القسم 5 يرفق بكل عميل مكرر عدد مستنداته، ليُعرف من يبقى.
--   * القسم 6 عملاء ينقصهم مفتاحهم الإلزامي (لا يمنع شيئاً، تحذير فقط).
--
-- العملاء الذين دُمجوا سابقاً (mergedIntoId غير فارغ) مستبعدون من كل الأقسام.
-- ============================================================================

BEGIN READ ONLY;

\echo '=== 0. صورة عامة لكل منشأة ==='
SELECT o."legalNameAr"                                                           AS "المنشأة",
       count(*)                                                                  AS "كل العملاء",
       count(*) FILTER (WHERE c."mergedIntoId" IS NOT NULL)                      AS "مدمجون سابقاً",
       count(*) FILTER (WHERE c."mergedIntoId" IS NULL AND coalesce(c."crNumber", '')  <> '') AS "لهم سجل تجاري",
       count(*) FILTER (WHERE c."mergedIntoId" IS NULL AND coalesce(c."vatNumber", '') <> '') AS "لهم رقم ضريبي",
       count(*) FILTER (WHERE c."mergedIntoId" IS NULL AND coalesce(c."mobile", '')    <> '') AS "لهم جوال موحّد",
       count(*) FILTER (WHERE c."mergedIntoId" IS NULL AND c."phone" IS NOT NULL AND c."mobile" IS NULL) AS "هاتف غير جوال (لم يُستنتج منه جوال)"
FROM "Customer" c
JOIN "Organization" o ON o."id" = c."organizationId"
GROUP BY o."id", o."legalNameAr"
ORDER BY o."legalNameAr";

\echo '=== 1. سجل تجاري مكرر (يُفشل 0023) ==='
SELECT o."legalNameAr" AS "المنشأة", c."crNumber" AS "السجل التجاري", count(*) AS "عدد العملاء",
       string_agg(c."code" || ' — ' || c."nameAr", E'\n' ORDER BY c."createdAt") AS "العملاء"
FROM "Customer" c
JOIN "Organization" o ON o."id" = c."organizationId"
WHERE c."mergedIntoId" IS NULL AND coalesce(c."crNumber", '') <> ''
GROUP BY o."id", o."legalNameAr", c."crNumber"
HAVING count(*) > 1
ORDER BY count(*) DESC, o."legalNameAr";

\echo '=== 2. رقم ضريبي مكرر (يُفشل 0023) ==='
SELECT o."legalNameAr" AS "المنشأة", c."vatNumber" AS "الرقم الضريبي", count(*) AS "عدد العملاء",
       string_agg(c."code" || ' — ' || c."nameAr", E'\n' ORDER BY c."createdAt") AS "العملاء"
FROM "Customer" c
JOIN "Organization" o ON o."id" = c."organizationId"
WHERE c."mergedIntoId" IS NULL AND coalesce(c."vatNumber", '') <> ''
GROUP BY o."id", o."legalNameAr", c."vatNumber"
HAVING count(*) > 1
ORDER BY count(*) DESC, o."legalNameAr";

\echo '=== 3. جوال مكرر بعد التوحيد إلى +9665xxxxxxxx (يُفشل 0023) ==='
SELECT o."legalNameAr" AS "المنشأة", c."mobile" AS "الجوال", count(*) AS "عدد العملاء",
       string_agg(c."code" || ' — ' || c."nameAr", E'\n' ORDER BY c."createdAt") AS "العملاء"
FROM "Customer" c
JOIN "Organization" o ON o."id" = c."organizationId"
WHERE c."mergedIntoId" IS NULL AND coalesce(c."mobile", '') <> ''
GROUP BY o."id", o."legalNameAr", c."mobile"
HAVING count(*) > 1
ORDER BY count(*) DESC, o."legalNameAr";

\echo '=== 3-ب. مفاتيح تختلف بمسافة أو حرف فقط (لا يلتقطها 0023 لكنها مكررات فعلية) ==='
SELECT o."legalNameAr" AS "المنشأة", 'سجل تجاري' AS "المفتاح", upper(btrim(c."crNumber")) AS "القيمة بعد التنظيف",
       count(*) AS "عدد العملاء", string_agg(c."code" || ' [' || c."crNumber" || ']', E'\n' ORDER BY c."createdAt") AS "العملاء"
FROM "Customer" c
JOIN "Organization" o ON o."id" = c."organizationId"
WHERE c."mergedIntoId" IS NULL AND btrim(coalesce(c."crNumber", '')) <> ''
GROUP BY o."id", o."legalNameAr", upper(btrim(c."crNumber"))
HAVING count(*) > 1 AND count(DISTINCT c."crNumber") > 1
UNION ALL
SELECT o."legalNameAr", 'رقم ضريبي', upper(btrim(c."vatNumber")),
       count(*), string_agg(c."code" || ' [' || c."vatNumber" || ']', E'\n' ORDER BY c."createdAt")
FROM "Customer" c
JOIN "Organization" o ON o."id" = c."organizationId"
WHERE c."mergedIntoId" IS NULL AND btrim(coalesce(c."vatNumber", '')) <> ''
GROUP BY o."id", o."legalNameAr", upper(btrim(c."vatNumber"))
HAVING count(*) > 1 AND count(DISTINCT c."vatNumber") > 1
ORDER BY 1, 2;

\echo '=== 4. اسم متطابق بعد التطبيع وإزالة كلمات الكيان القانوني (تقريب) ==='
-- nameNormalized مطبّع أصلاً (تشكيل، ألف، تاء مربوطة، «ال»، علامات ترقيم).
-- هنا تُحذف أيضاً كلمات الكيان القانوني بعد تطبيعها: شركه، موسسه، مجموعه،
-- محدوده، شمم، ذمم، للتجاره، للمقاولات، co، ltd، llc، est، company.
-- كلمات النشاط (مصنع، مكتب، مستودع) تبقى، فلا تتطابق «شركة الرياض» و«مصنع الرياض».
WITH comparable AS (
  SELECT c."id", c."organizationId", c."code", c."nameAr", c."createdAt",
         btrim(regexp_replace(
           ' ' || coalesce(c."nameNormalized", npi_normalize_arabic_name(c."nameAr")) || ' ',
           ' (شركه|موسسه|مجموعه|محدوده|شمم|ذمم|للتجاره|للمقاولات|co|ltd|llc|est|company)(?= )',
           '', 'g')) AS "key"
  FROM "Customer" c
  WHERE c."mergedIntoId" IS NULL
)
SELECT o."legalNameAr" AS "المنشأة", k."key" AS "الاسم المقارَن", count(*) AS "عدد العملاء",
       string_agg(k."code" || ' — ' || k."nameAr", E'\n' ORDER BY k."createdAt") AS "العملاء"
FROM comparable k
JOIN "Organization" o ON o."id" = k."organizationId"
WHERE k."key" <> ''
GROUP BY o."id", o."legalNameAr", k."key"
HAVING count(*) > 1
ORDER BY count(*) DESC, o."legalNameAr";

\echo '=== 5. مستندات كل عميل ضمن مجموعات المفاتيح المكررة (لاختيار الباقي) ==='
WITH dup AS (
  SELECT c."id" FROM "Customer" c
  WHERE c."mergedIntoId" IS NULL AND coalesce(c."crNumber", '') <> ''
    AND EXISTS (SELECT 1 FROM "Customer" d WHERE d."organizationId" = c."organizationId" AND d."mergedIntoId" IS NULL
                AND d."crNumber" = c."crNumber" AND d."id" <> c."id")
  UNION
  SELECT c."id" FROM "Customer" c
  WHERE c."mergedIntoId" IS NULL AND coalesce(c."vatNumber", '') <> ''
    AND EXISTS (SELECT 1 FROM "Customer" d WHERE d."organizationId" = c."organizationId" AND d."mergedIntoId" IS NULL
                AND d."vatNumber" = c."vatNumber" AND d."id" <> c."id")
  UNION
  SELECT c."id" FROM "Customer" c
  WHERE c."mergedIntoId" IS NULL AND coalesce(c."mobile", '') <> ''
    AND EXISTS (SELECT 1 FROM "Customer" d WHERE d."organizationId" = c."organizationId" AND d."mergedIntoId" IS NULL
                AND d."mobile" = c."mobile" AND d."id" <> c."id")
)
SELECT o."legalNameAr" AS "المنشأة", c."code" AS "الرمز", c."nameAr" AS "الاسم",
       c."crNumber" AS "السجل التجاري", c."vatNumber" AS "الرقم الضريبي", c."mobile" AS "الجوال",
       (SELECT count(*) FROM "Lead"        x WHERE x."customerId" = c."id") AS "عملاء محتملون",
       (SELECT count(*) FROM "Opportunity" x WHERE x."customerId" = c."id") AS "فرص",
       (SELECT count(*) FROM "Contract"    x WHERE x."customerId" = c."id") AS "عقود",
       (SELECT count(*) FROM "Invoice"     x WHERE x."customerId" = c."id") AS "فواتير",
       c."createdAt"::date AS "تاريخ الإنشاء"
FROM "Customer" c
JOIN dup ON dup."id" = c."id"
JOIN "Organization" o ON o."id" = c."organizationId"
ORDER BY o."legalNameAr", coalesce(c."crNumber", c."vatNumber", c."mobile"), c."createdAt";

\echo '=== 6. عملاء ينقصهم مفتاحهم الإلزامي (منشأة بلا سجل أو رقم ضريبي، فرد بلا جوال) ==='
SELECT o."legalNameAr" AS "المنشأة", c."entityKind" AS "نوع الكيان", count(*) AS "عدد العملاء",
       string_agg(c."code", '، ' ORDER BY c."code") AS "الرموز"
FROM "Customer" c
JOIN "Organization" o ON o."id" = c."organizationId"
WHERE c."mergedIntoId" IS NULL
  AND ((c."entityKind" = 'COMPANY'    AND coalesce(c."crNumber", '') = '' AND coalesce(c."vatNumber", '') = '')
    OR (c."entityKind" = 'INDIVIDUAL' AND coalesce(c."mobile", '') = ''))
GROUP BY o."id", o."legalNameAr", c."entityKind"
ORDER BY o."legalNameAr";

ROLLBACK;
