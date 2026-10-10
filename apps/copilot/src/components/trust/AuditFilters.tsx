'use client';

import { t, type ArKey } from '@/i18n/ar';
import { KNOWN_AUDIT_EVENTS } from '@/audit/types';
import type { AuditFilters as AuditFiltersValue, AuditUserRef } from '@/audit/types';

const SELECT_CLASS =
  'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

export interface AuditFiltersProps {
  filters: AuditFiltersValue;
  users: AuditUserRef[];
  onChange(filters: AuditFiltersValue): void;
}

function imageSelectValue(filters: AuditFiltersValue): string {
  if (filters.imageSent === undefined) return '';
  return filters.imageSent ? 'true' : 'false';
}

/** The three filters of the trust log. A change applies immediately — there
 *  is no apply button. An empty value means «الكل» (no filter). */
export function AuditFilters({ filters, users, onChange }: AuditFiltersProps) {
  function withEvent(value: string): AuditFiltersValue {
    const { event: _event, ...rest } = filters;
    return value === '' ? rest : { ...rest, event: value };
  }
  function withImage(value: string): AuditFiltersValue {
    const { imageSent: _imageSent, ...rest } = filters;
    return value === '' ? rest : { ...rest, imageSent: value === 'true' };
  }
  function withUser(value: string): AuditFiltersValue {
    const { npiUserId: _npiUserId, ...rest } = filters;
    return value === '' ? rest : { ...rest, npiUserId: value };
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="trust-filters">
      <div className="flex flex-col gap-1">
        <label htmlFor="trust-filter-event" className="text-xs font-semibold text-slate-600">
          {t('trust.filter.event')}
        </label>
        <select
          id="trust-filter-event"
          data-testid="trust-filter-event"
          className={SELECT_CLASS}
          value={filters.event ?? ''}
          onChange={(e) => onChange(withEvent(e.target.value))}
        >
          <option value="">{t('trust.filter.all')}</option>
          {KNOWN_AUDIT_EVENTS.map((key) => (
            <option key={key} value={key}>
              {t(`trust.event.${key}` as ArKey)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="trust-filter-image" className="text-xs font-semibold text-slate-600">
          {t('trust.filter.image_sent')}
        </label>
        <select
          id="trust-filter-image"
          data-testid="trust-filter-image"
          className={SELECT_CLASS}
          value={imageSelectValue(filters)}
          onChange={(e) => onChange(withImage(e.target.value))}
        >
          <option value="">{t('trust.filter.all')}</option>
          <option value="true">{t('trust.filter.images_only')}</option>
          <option value="false">{t('trust.filter.no_images')}</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="trust-filter-user" className="text-xs font-semibold text-slate-600">
          {t('trust.filter.user')}
        </label>
        <select
          id="trust-filter-user"
          data-testid="trust-filter-user"
          className={SELECT_CLASS}
          value={filters.npiUserId ?? ''}
          onChange={(e) => onChange(withUser(e.target.value))}
        >
          <option value="">{t('trust.filter.all')}</option>
          {users.map((user) => (
            <option key={user.npiUserId} value={user.npiUserId}>
              {user.nameAr ?? user.npiUserId}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
