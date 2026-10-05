import { AssistantBadge } from '@/components/AssistantBadge';
import { MemoryNote } from '@/components/MemoryNote';
import { IntakePanel } from '@/components/intake/IntakePanel';
import { Button } from '@/components/ui/Button';
import { t, type ArKey } from '@/i18n/ar';
import { FLOW_TYPES } from '@/onboarding/profile.schema';
import type { FlowType } from '@/intake/types';
import type { ChatMessage } from './api';

const NOTICE_TONE: Record<string, string> = {
  hr_refusal: 'border-warning-200 bg-warning-50 text-warning-800',
  error: 'border-danger-200 bg-danger-50 text-danger-800',
};

/**
 * One turn in the log. The design spec does not state which side each
 * speaker sits on; this app's own decision (not spec/madar/03-DESIGN-SPEC.md)
 * is the mirror of how chat apps place sent/received bubbles in LTR
 * languages: the ASSISTANT's replies sit at the inline START (the right side
 * in this RTL UI — where reading begins, so the assistant "speaks first" from
 * the reading edge) and the USER's own messages at the inline END, in a
 * brand-tinted bubble with a visible border. `justify-start`/`justify-end`
 * are logical in Tailwind (they follow the RTL `dir` on `<html>`), so no
 * `ms-`/`me-` juggling is needed on the row itself.
 *
 * Text is always rendered as a text child (`{message.textAr}`), never through
 * `dangerouslySetInnerHTML` — an assistant reply is model output and must
 * never be interpreted as markup. No `dir="auto"` either: a reply that
 * starts with a document code (e.g. `PRJ-00012`) must still read
 * right-to-left, which `dir="auto"`'s first-strong-character heuristic would
 * flip to LTR.
 */
export interface MessageProps {
  message: ChatMessage;
  /** Called when the user picks a flow on a `choose_flow` reply (T-26). */
  onChooseFlow?: (flow: FlowType, documentId: string) => void;
  /** Disables the flow chips while any intake read is in flight. */
  chipsDisabled?: boolean;
}

export function Message({ message, onChooseFlow, chipsDisabled = false }: MessageProps) {
  const isUser = message.role === 'user';
  const hasIntake = !isUser && message.kind === 'intake' && message.intakeJobId !== undefined;
  const showChips =
    !isUser && message.kind === 'choose_flow' && message.documentId !== undefined && onChooseFlow !== undefined;
  const notice = message.kind ? NOTICE_TONE[message.kind] : undefined;

  const bubbleClass = isUser
    ? 'border border-brand-200 bg-brand-50 text-slate-900'
    : notice
      ? `border ${notice}`
      : 'border border-slate-200 bg-white text-slate-900';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex flex-col gap-1.5 ${hasIntake ? 'w-full max-w-full' : 'max-w-[85%] sm:max-w-[70%]'}`}>
        <div className={`rounded-2xl px-3.5 py-2.5 text-sm ${bubbleClass}`}>
          <p className="whitespace-pre-wrap break-words leading-6">{message.textAr}</p>
          {showChips ? <p className="mt-1 text-xs text-slate-500">{t('chat.choose_flow_hint')}</p> : null}
        </div>
        {showChips ? (
          <div data-testid="flow-chips" className="flex flex-wrap gap-2">
            {FLOW_TYPES.map((flow) => (
              <Button
                key={flow}
                type="button"
                variant="secondary"
                size="sm"
                disabled={chipsDisabled}
                onClick={() => onChooseFlow(flow, message.documentId!)}
              >
                {t(`flow.${flow}` as ArKey)}
              </Button>
            ))}
          </div>
        ) : null}
        {hasIntake ? <IntakePanel id={message.intakeJobId!} compact /> : null}
        {!isUser && message.badges.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {message.badges.map((label, i) => (
              // Badge text is server-supplied data, not a stable key; index is
              // fine since this list never reorders after render.
              <AssistantBadge key={`${message.id}-badge-${i}`} label={label} />
            ))}
          </div>
        ) : null}
        {!isUser && message.memoryNotes.length > 0 ? (
          <div className="flex flex-col gap-1">
            {message.memoryNotes.map((note) => (
              <MemoryNote key={note.id} note={note} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
