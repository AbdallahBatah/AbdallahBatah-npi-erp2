'use client';
import { useParams } from 'next/navigation';
import { PaymentRequestDetail } from '@/components/payment-requests';
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <PaymentRequestDetail id={id} base="/projects/payment-requests" />;
}
