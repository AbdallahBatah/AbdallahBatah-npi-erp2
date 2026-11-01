/**
 * Package 7 (ADR-07) — the acceptance & commissioning certificate (contract
 * annex 2) as data both sides read: its inspection items, its test readings,
 * and the warranty periods that start on acceptance.
 *
 * The eight items and the default years are a design proposal pending the
 * owner's own form (GAP_AR §9-6: «تُصمَّم على غرار نماذج الشركة وتُعرض قبل
 * البناء»); the years are editable on every handover.
 */

export interface HandoverCheckItem {
  key: string;
  labelAr: string;
  labelEn: string;
}

export const HANDOVER_CHECKLIST: readonly HandoverCheckItem[] = [
  { key: 'STRUCTURE', labelAr: 'الهياكل مثبتة ومحكمة حسب المخطط', labelEn: 'Structures fixed and tightened to drawing' },
  { key: 'PANELS', labelAr: 'الألواح مركبة ونظيفة وبلا كسر', labelEn: 'Panels mounted, clean, undamaged' },
  { key: 'DC_CABLING', labelAr: 'كابلات وتوصيلات التيار المستمر سليمة ومثبتة', labelEn: 'DC cabling and connectors sound and secured' },
  { key: 'INVERTER', labelAr: 'المحوِّل مركب ومضبوط ويعمل', labelEn: 'Inverter installed, configured, running' },
  { key: 'AC_PROTECTION', labelAr: 'جهة التيار المتردد والقواطع والحمايات', labelEn: 'AC side, breakers and protection' },
  { key: 'EARTHING', labelAr: 'التأريض وقياس مقاومته', labelEn: 'Earthing and its resistance test' },
  { key: 'MONITORING', labelAr: 'نظام المراقبة متصل ويقرأ', labelEn: 'Monitoring system connected and reading' },
  { key: 'LABELS_SAFETY', labelAr: 'اللوحات التعريفية وإشارات السلامة', labelEn: 'Labels and safety signage' },
];

export const HANDOVER_READINGS: readonly { label: string; unit: string }[] = [
  { label: 'DC voltage', unit: 'V' },
  { label: 'DC current', unit: 'A' },
  { label: 'AC voltage', unit: 'V' },
  { label: 'AC current', unit: 'A' },
  { label: 'Frequency', unit: 'Hz' },
];

export const WARRANTY_KINDS = [
  { value: 'PANELS_PRODUCT', labelAr: 'الألواح — المنتج', labelEn: 'Panels — product', defaultYears: 12 },
  { value: 'PANELS_PERFORMANCE', labelAr: 'الألواح — الأداء', labelEn: 'Panels — performance', defaultYears: 25 },
  { value: 'INVERTER', labelAr: 'المحوِّل', labelEn: 'Inverter', defaultYears: 5 },
  { value: 'STRUCTURE', labelAr: 'الهياكل', labelEn: 'Structures', defaultYears: 10 },
  { value: 'WORKMANSHIP', labelAr: 'المصنعية', labelEn: 'Workmanship', defaultYears: 2 },
] as const;

export type WarrantyKindValue = (typeof WARRANTY_KINDS)[number]['value'];
