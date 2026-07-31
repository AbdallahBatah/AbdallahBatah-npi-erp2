'use client';

/**
 * Role-filtered shortcuts on the dashboard. The 3-click rule is mostly a
 * routing problem: every one of these used to take sidebar → list → button.
 * Each entry is gated on the WRITE permission of the thing it starts, not the
 * read permission of the screen it lands on — offering "new invoice" to
 * someone who can only view invoices is exactly the noise we removed from the
 * action buttons themselves.
 *
 * `?new=1` tells the destination page to open its create modal on arrival.
 */
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { Icon } from './icons';

interface QuickAction {
  href: string;
  key: string;
  icon: string;
  perm: string;
}

const ACTIONS: QuickAction[] = [
  { href: '/leads?new=1', key: 'leads.new', icon: 'target', perm: 'crm.lead.write' },
  { href: '/customers?new=1', key: 'cust.new', icon: 'users', perm: 'crm.customer.write' },
  { href: '/opportunities?new=1', key: 'opps.new', icon: 'lightbulb', perm: 'crm.opportunity.write' },
  { href: '/workorders?new=1', key: 'wo.new', icon: 'wrench', perm: 'fsm.workorder.write' },
  { href: '/procurement?new=1', key: 'po.new', icon: 'cart', perm: 'scm.procurement.write' },
  { href: '/payables', key: 'ap.title', icon: 'wallet', perm: 'finance.payment.write' },
  { href: '/invoices', key: 'nav.invoices', icon: 'receipt', perm: 'finance.invoice.write' },
];

export function QuickActions() {
  const { t } = useI18n();
  const { can } = useAuth();
  const visible = ACTIONS.filter((a) => can(a.perm));
  if (visible.length === 0) return null;

  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {visible.map((a) => (
        <Link
          key={a.href}
          href={a.href}
          className="btn-ghost !px-3 !py-1.5 text-xs"
        >
          <Icon name={a.icon} className="h-4 w-4 text-slate-400" />
          {t(a.key)}
        </Link>
      ))}
    </div>
  );
}
