import { t, type ArKey } from '@/i18n/ar';
import { Badge } from '@/components/ui/Badge';
import type { IntakeDocumentView } from '@/intake/types';

const KIND_LABEL_KEY: Record<IntakeDocumentView['kind'], ArKey> = {
  pdf_text: 'intake.kind.pdf_text',
  pdf_scanned: 'intake.kind.pdf_scanned',
  image: 'intake.kind.image',
};

/**
 * The attached document on a preview card (spec/madar/03 §2 `DocumentChip`):
 * its file name and a kind badge (نصي / ممسوح / صورة). Inline and wrapping so
 * a long file name breaks instead of widening the card.
 */
export function DocumentChip({ document }: { document: IntakeDocumentView }) {
  return (
    <span data-testid="document-chip" className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      <bdi className="break-words text-xs font-semibold text-slate-800">{document.fileName}</bdi>
      <Badge tone="neutral">{t(KIND_LABEL_KEY[document.kind])}</Badge>
    </span>
  );
}
