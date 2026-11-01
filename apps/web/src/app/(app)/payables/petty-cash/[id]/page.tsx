'use client';
import { useParams } from 'next/navigation';
import { CustodyDetail } from '@/components/petty-cash';
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <CustodyDetail id={id} base="/payables/petty-cash" />;
}
