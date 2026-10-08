'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { t } from '@/i18n/ar';
import {
  isSpeechSupported,
  startDictation,
  type SpeechErrorKind,
  type SpeechSession,
} from '@/voice/speech';

/** What the button is doing; the composer shows the matching status line. */
export type MicState = 'idle' | 'listening' | 'unsupported' | 'error';

export interface MicButtonProps {
  /** The composer text at the moment dictation starts is kept as the base;
   *  every update replaces the whole draft with base + final + interim. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Reports state so the composer can show the hint line. `errorKind` is
   *  set only with `'error'`. */
  onStateChange?: (state: MicState, errorKind?: SpeechErrorKind) => void;
}

/** Joins the non-empty trimmed parts with one space. */
function joinDraft(parts: readonly string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(' ');
}

/**
 * Dictation button (T-38, F-21): one click starts the browser's speech
 * recognizer in Saudi Arabic, a second click stops it. The recognised words
 * stream into the composer as an ordinary draft — never sent by this
 * component. The user reads and corrects the text, then presses the normal
 * send button, so the dictated message is redacted and answered exactly like a
 * typed one (spec/madar/08 §E: no new path to a model).
 *
 * Support is detected in an effect, after mount, not during render: the
 * server render and the first client render both show the enabled button, so
 * there is no hydration mismatch; if the API turns out to be missing the state
 * then flips to `unsupported` and the button is disabled with an explanatory
 * title.
 *
 * A recognition error (permission denied, no speech heard, service offline)
 * leaves the button in `error` and the text already dictated in place; the
 * browser fires `end` right after most errors, which must not erase the error
 * state, so `end` only moves `listening` back to `idle`. The next click
 * simply starts again.
 */
export function MicButton({ value, onChange, disabled = false, onStateChange }: MicButtonProps) {
  const [state, setState] = useState<MicState>('idle');
  const stateRef = useRef<MicState>('idle');
  const sessionRef = useRef<SpeechSession | null>(null);
  const baseRef = useRef('');
  // Latest callbacks, so a long-lived recognizer never calls a stale closure.
  const onChangeRef = useRef(onChange);
  const onStateChangeRef = useRef(onStateChange);
  onChangeRef.current = onChange;
  onStateChangeRef.current = onStateChange;

  const report = useCallback((next: MicState, errorKind?: SpeechErrorKind) => {
    stateRef.current = next;
    setState(next);
    onStateChangeRef.current?.(next, errorKind);
  }, []);

  // Detect support after mount (see the component comment).
  useEffect(() => {
    if (!isSpeechSupported()) report('unsupported');
  }, [report]);

  // Never leave a recognizer (and the microphone) running after unmount.
  useEffect(() => {
    return () => {
      sessionRef.current?.abort();
      sessionRef.current = null;
    };
  }, []);

  // If the composer becomes disabled mid-dictation (a message is being
  // answered), stop listening at once; the draft typed so far stays.
  useEffect(() => {
    if (disabled && sessionRef.current) {
      sessionRef.current.abort();
      sessionRef.current = null;
      if (stateRef.current === 'listening') report('idle');
    }
  }, [disabled, report]);

  function start() {
    baseRef.current = value.trim();
    const session = startDictation({
      onUpdate: ({ finalText, interimText }) => {
        onChangeRef.current(joinDraft([baseRef.current, finalText, interimText]));
      },
      onEnd: () => {
        sessionRef.current = null;
        // Keep an error visible: most errors are followed by `end`.
        if (stateRef.current === 'listening') report('idle');
      },
      onError: (kind) => {
        if (kind === 'unsupported') report('unsupported');
        else report('error', kind);
      },
    });
    sessionRef.current = session;
    if (session) report('listening');
  }

  function handleClick() {
    if (stateRef.current === 'listening') {
      sessionRef.current?.stop();
      return;
    }
    start();
  }

  const listening = state === 'listening';
  const unsupported = state === 'unsupported';
  const label = listening ? t('chat.mic_stop') : t('chat.mic');
  const title = unsupported ? t('chat.mic_unsupported') : label;

  return (
    <button
      type="button"
      data-testid="mic-button"
      onClick={handleClick}
      disabled={disabled || unsupported}
      aria-pressed={listening}
      title={title}
      aria-label={label}
      className={[
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent',
        listening
          ? 'text-brand-600 ring-2 ring-brand-500 animate-pulse motion-reduce:animate-none'
          : 'text-slate-600 hover:bg-slate-100',
      ].join(' ')}
    >
      {listening ? (
        <Square className="h-5 w-5" aria-hidden="true" />
      ) : (
        <Mic className="h-5 w-5" aria-hidden="true" />
      )}
    </button>
  );
}
