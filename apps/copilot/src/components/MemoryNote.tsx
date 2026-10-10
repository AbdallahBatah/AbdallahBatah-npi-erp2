import { t } from '@/i18n/ar';
import type { MemoryNoteData } from '@/components/chat/api';

/** A small bordered note under an assistant message, headed `memory.note`,
 *  showing one remembered fact the reply drew on. */
export function MemoryNote({ note }: { note: MemoryNoteData }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
      <p className="font-semibold text-slate-500">{t('memory.note')}</p>
      <p className="mt-0.5 leading-6">{note.factAr}</p>
    </div>
  );
}
