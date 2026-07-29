'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

export interface EnumOption {
  value: string;
  labelAr: string;
  labelEn: string;
}

export interface EnumSets {
  customerTypes: EnumOption[];
  leadSources: EnumOption[];
  leadStatuses: EnumOption[];
  opportunityStages: EnumOption[];
  itemCategories: EnumOption[];
  proposalStatuses: EnumOption[];
  contractTypes: EnumOption[];
  contractStatuses: EnumOption[];
  milestoneTriggerTypes: EnumOption[];
  milestoneStatuses: EnumOption[];
  invoiceTypes: EnumOption[];
  invoiceStatuses: EnumOption[];
  projectStages: EnumOption[];
  vendorTypes: EnumOption[];
  poStatuses: EnumOption[];
  serialStates: EnumOption[];
  costTypes: EnumOption[];
  billStatuses: EnumOption[];
  changeOrderStatuses: EnumOption[];
  subcontractStatuses: EnumOption[];
  claimStatuses: EnumOption[];
  locationTypes: EnumOption[];
  assetTypes: EnumOption[];
  assetStatuses: EnumOption[];
  woTypes: EnumOption[];
  woOrigins: EnumOption[];
  woPriorities: EnumOption[];
  woStatuses: EnumOption[];
  alertTypes: EnumOption[];
  alertSeverities: EnumOption[];
  alertStatuses: EnumOption[];
}

let cache: EnumSets | null = null;

export function useEnums(): EnumSets | null {
  const [enums, setEnums] = useState<EnumSets | null>(cache);
  useEffect(() => {
    if (cache) return;
    api
      .get<EnumSets>('/reference/enums')
      .then((e) => {
        cache = e;
        setEnums(e);
      })
      .catch(() => setEnums(null));
  }, []);
  return enums;
}

export function optionLabel(
  options: EnumOption[] | undefined,
  value: string,
  locale: 'ar' | 'en',
): string {
  const opt = options?.find((o) => o.value === value);
  if (!opt) return value;
  return locale === 'ar' ? opt.labelAr : opt.labelEn;
}
