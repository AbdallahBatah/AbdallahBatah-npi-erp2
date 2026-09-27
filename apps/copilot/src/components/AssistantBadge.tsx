import { Badge } from '@/components/ui/Badge';

/** One badge under an assistant message, naming the tool or flow behind the
 *  reply (spec/madar/03 §2). Text is data (an Arabic label already resolved
 *  server-side), never a `t()` key — it never contains Latin letters. */
export function AssistantBadge({ label }: { label: string }) {
  return <Badge tone="brand">{label}</Badge>;
}
