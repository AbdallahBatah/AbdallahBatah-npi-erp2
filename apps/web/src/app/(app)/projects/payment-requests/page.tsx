'use client';
/** Package 6 · P6-1: payment requests for the engineer and the signers. */
import { PaymentRequestList } from '@/components/payment-requests';
export default function Page() {
  return <PaymentRequestList base="/projects/payment-requests" />;
}
