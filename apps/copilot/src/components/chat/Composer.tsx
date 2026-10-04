'use client';

import { forwardRef, useId, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { Mic, Paperclip, SendHorizontal } from 'lucide-react';
import { t } from '@/i18n/ar';
import { formatNumber } from '@/i18n/format';
import { Button } from '@/components/ui/Button';
import { MAX_MESSAGE_LENGTH, COUNTER_THRESHOLD } from './api';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Called with the chosen file once the browser's file picker returns
   *  (T-22). The input is reset right after so the same file can be
   *  re-chosen (e.g. after a refusal). */
  onAttach: (file: File) => void;
  disabled?: boolean;
  /** Disables only the attach button — set while a previous attachment is
   *  still uploading or while a `ConsentCard` is pending, independent of
   *  the composer's own `disabled` (which gates sending text). */
  attachDisabled?: boolean;
}

/**
 * The message input: a labelled textarea (Enter sends, Shift+Enter inserts a
 * newline), a send button, a character counter that only appears once the
 * message is getting long, and the attach/mic buttons.
 *
 * The attach button (T-22) is live: it opens the browser's file picker
 * through a visually hidden `<input type="file">` and calls `onAttach` with
 * the chosen file — the upload itself, and everything that follows it
 * (consent, notices), is `Chat.tsx`'s job. The mic button stays disabled:
 * voice input belongs to a later milestone (spec/madar/03 §2 lists it; the
 * flow behind it is not built yet).
 */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSend, onAttach, disabled = false, attachDisabled = false },
  ref,
) {
  const textareaId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trimmed = value.trim();
  const tooLong = value.length > MAX_MESSAGE_LENGTH;
  const canSend = !disabled && trimmed.length > 0 && !tooLong;
  const attachButtonDisabled = disabled || attachDisabled;

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }

  function handleAttachClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset first so the same file can be re-chosen even if `onAttach`
    // throws synchronously (it shouldn't — `Chat.tsx`'s handler never
    // throws — but the reset must not depend on that).
    e.target.value = '';
    if (file) onAttach(file);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={textareaId} className="sr-only">
        {t('chat.placeholder')}
      </label>
      {/* Hidden, not removed from the a11y tree by anything other than
          `aria-hidden` + `tabIndex={-1}` — a hidden `<input type="file">`
          still accepts Playwright's `setInputFiles` and still opens the
          native picker on `.click()`. */}
      <input
        ref={fileInputRef}
        type="file"
        data-testid="attach-input"
        accept="application/pdf,image/jpeg,image/png,image/heic,image/heif"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileChange}
      />
      <div className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white p-2 focus-within:ring-2 focus-within:ring-brand-500">
        <button
          type="button"
          onClick={handleAttachClick}
          disabled={attachButtonDisabled}
          title={t('chat.attach')}
          aria-label={t('chat.attach')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-600 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
        >
          <Paperclip className="h-5 w-5" aria-hidden="true" />
        </button>
        <textarea
          id={textareaId}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={t('chat.placeholder')}
          rows={1}
          className="max-h-40 min-h-11 flex-1 resize-none bg-transparent py-2 text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none disabled:text-slate-400"
        />
        <button
          type="button"
          disabled
          title={t('chat.later')}
          aria-label={t('chat.mic')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-400 disabled:cursor-not-allowed"
        >
          <Mic className="h-5 w-5" aria-hidden="true" />
        </button>
        <Button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          aria-label={t('chat.send')}
          className="shrink-0"
        >
          <SendHorizontal className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
        </Button>
      </div>
      {/* The mic button above has no hover state worth relying on for "why
          can't I click this" — this line explains it up front, in addition
          to its `title`. The attach button went live in T-22, so this hint
          now covers only what remains disabled: voice input. */}
      <p className="px-1 text-xs text-slate-500">{t('chat.later_hint')}</p>
      {value.length >= COUNTER_THRESHOLD ? (
        <p dir="rtl" className={`px-1 text-xs ${tooLong ? 'text-danger-600' : 'text-slate-500'}`}>
          <bdi>{formatNumber(value.length)}</bdi> / <bdi>{formatNumber(MAX_MESSAGE_LENGTH)}</bdi>
        </p>
      ) : null}
      {tooLong ? (
        <p dir="rtl" className="px-1 text-xs text-danger-600">
          {t('chat.error.too_long')}
        </p>
      ) : null}
    </div>
  );
});
