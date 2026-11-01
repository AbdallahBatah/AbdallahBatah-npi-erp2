'use client';
/** Package 6 · P6-2: the custodian's (and the projects GM's) view of petty cash. */
import { CustodyList } from '@/components/petty-cash';
export default function Page() {
  return <CustodyList base="/projects/petty-cash" />;
}
