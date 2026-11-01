'use client';
/** Package 6 · P6-1: the accountant's view — pays approved requests. */
import { PaymentRequestList } from '@/components/payment-requests';
export default function Page() {
  return <PaymentRequestList base="/payables/payment-requests" />;
}
