'use client';

/**
 * The approvals screen — package و.
 *
 * Two tabs, two audiences. "Waiting on me" is every user's working list and
 * needs no permission: it is scoped to the caller's own role by the server.
 * "History" is the control view and is gated on admin.approval.manage, the
 * same permission that configures the matrix.
 */
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { PageHeader, Tabs } from '@/components/ui';
import { ApprovalHistory, ApprovalInbox } from '@/components/approvals';

export default function ApprovalsPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const canManage = can('admin.approval.manage');
  const [tab, setTab] = useState<'inbox' | 'history'>('inbox');

  return (
    <div>
      <PageHeader title={t('apr.title')} subtitle={t('apr.hint')} />

      {canManage && (
        <Tabs
          tabs={[
            { key: 'inbox', label: t('apr.tab.inbox') },
            { key: 'history', label: t('apr.tab.history') },
          ]}
          value={tab}
          onChange={(k) => setTab(k as 'inbox' | 'history')}
        />
      )}

      {tab === 'history' && canManage ? <ApprovalHistory /> : <ApprovalInbox />}
    </div>
  );
}
