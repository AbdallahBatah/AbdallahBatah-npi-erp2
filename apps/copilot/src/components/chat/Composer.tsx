'use client';

import { forwardRef, useId, type KeyboardEvent } from 'react';
import { Mic, Paperclip, SendHorizontal } from 'lucide-react';
import { t } from '@/i18n/ar';
import { Button } from '@/components/ui/Button';
import { MAX_MESSAGE_LENGTH, COUNTER_THRESHOLD } from './api';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
}

/**
 * The message input: a labelled textarea (Enter sends, Shift+Enter inserts a
 * newline), a send button, a character counter that only appears once the
 * message is getting long, and the attach/mic buttons — rendered disabled
 * because both belong to a later milestone (spec/madar/03 §2 lists them; the
 * flows behind them are not built yet).
 */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSend, disabled = false },
  ref,
) {
  const textareaId = useId();
  const trimmed = value.trim();
  const tooLong = value.length > MAX_MESSAGE_LENGTH;
  const canSend = !disabled && trimmed.length > 0 && !tooLong;

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={textareaId} className="sr-only">
        {t('chat.placeholder')}
      </label>
      <div className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white p-2 focus-within:ring-2 focus-within:ring-brand-500">
        <button
          type="button"
          disabled
          title={t('chat.later')}
          aria-label={t('chat.attach')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-400 disabled:cursor-not-allowed"
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
          className="max-h-40 min-h-11 flex-1 resize-none bg-transparent py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:text-slate-400"
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
      {value.length >= COUNTER_THRESHOLD ? (
        <p
          className={`px-1 text-xs ${tooLong ? 'text-danger-600' : 'text-slate-500'}`}
          dir="ltr"
        >
          {value.length.toLocaleString('ar-SA-u-nu-latn')} / {MAX_MESSAGE_LENGTH.toLocaleString('ar-SA-u-nu-latn')}
        </p>
      ) : null}
      {tooLong ? <p className="px-1 text-xs text-danger-600">{t('chat.error.too_long')}</p> : null}
    </div>
  );
});
