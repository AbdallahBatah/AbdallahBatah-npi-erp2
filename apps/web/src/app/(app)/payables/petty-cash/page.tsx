'use client';
/** Package 6 · P6-2: the accountant opens, funds, takes back and closes custodies. */
import { CustodyList } from '@/components/petty-cash';
export default function Page() {
  return <CustodyList base="/payables/petty-cash" />;
}
