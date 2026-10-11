'use client';

import { forwardRef, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Paperclip, SendHorizontal } from 'lucide-react';
import { t, type ArKey } from '@/i18n/ar';
import type { SpeechErrorKind } from '@/voice/speech';
import { formatNumber } from '@/i18n/format';
import { Button } from '@/components/ui/Button';
import { MAX_MESSAGE_LENGTH, COUNTER_THRESHOLD } from './api';
import { CameraButton } from './CameraButton';
import { MicButton, type MicState } from './MicButton';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Called with the chosen file once the browser's file picker returns
   *  (T-22), or with the prepared photo when the camera button is used
   *  (T-38) — both take the same upload -> consent -> intake path. The
   *  picker's input is reset right after so the same file can be re-chosen
   *  (e.g. after a refusal). */
  onAttach: (file: File) => void;
  disabled?: boolean;
  /** Disables only the attach and camera buttons — set while a previous attachment is
   *  still uploading or while a `ConsentCard` is pending, independent of
   *  the composer's own `disabled` (which gates sending text). */
  attachDisabled?: boolean;
}

/**
 * The message input: a labelled textarea (Enter sends, Shift+Enter inserts a
 * newline), a send button, a character counter that only appears once the
 * message is getting long, and the attach, camera and mic buttons.
 *
 * The attach button (T-22) is live: it opens the browser's file picker
 * through a visually hidden `<input type="file">` and calls `onAttach` with
 * the chosen file — the upload itself, and everything that follows it
 * (consent, notices), is `Chat.tsx`'s job.
 *
 * T-38 added two more inputs, both feeding paths that already existed:
 *  - `CameraButton` (phones only) opens the OS camera and hands the photo,
 *    downscaled if it is too big, to the same `onAttach`.
 *  - `MicButton` dictates into the textarea. The words are an ordinary draft:
 *    the user reviews them and presses send, so they are redacted and
 *    answered like typed text. The line under the box reports the mic's
 *    state (listening, unsupported, or why dictation failed) in a polite
 *    live region; it is empty when idle but keeps its height so the composer
 *    does not jump.
 */

/** Which `chat.mic_error.*` string explains a dictation failure. */
function micErrorKey(kind: SpeechErrorKind | undefined): ArKey {
  switch (kind) {
    case 'not-allowed':
      return 'chat.mic_error.not_allowed';
    case 'no-speech':
      return 'chat.mic_error.no_speech';
    case 'network':
      return 'chat.mic_error.network';
    default:
      return 'chat.mic_error.other';
  }
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSend, onAttach, disabled = false, attachDisabled = false },
  ref,
) {
  const textareaId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [micState, setMicState] = useState<MicState>('idle');
  const [micErrorKind, setMicErrorKind] = useState<SpeechErrorKind | undefined>(undefined);
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

  function handleMicStateChange(state: MicState, errorKind?: SpeechErrorKind) {
    setMicState(state);
    setMicErrorKind(state === 'error' ? errorKind : undefined);
  }

  const micStatus =
    micState === 'listening'
      ? t('chat.mic_listening')
      : micState === 'unsupported'
        ? t('chat.mic_unsupported')
        : micState === 'error'
          ? t(micErrorKey(micErrorKind))
          : '';

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
        <CameraButton onCapture={onAttach} disabled={attachButtonDisabled} />
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
        <MicButton value={value} onChange={onChange} disabled={disabled} onStateChange={handleMicStateChange} />
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
      {/* Live region for the mic's state. It is always mounted (a live region
          must exist before its text changes to be announced) and keeps a
          minimum height so the composer does not jump when text appears. */}
      <output
        aria-live="polite"
        data-testid="mic-status"
        className={`block min-h-4 px-1 text-xs ${micState === 'error' ? 'text-danger-600' : 'text-slate-500'}`}
      >
        {micStatus}
      </output>
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
