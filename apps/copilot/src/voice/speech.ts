/**
 * Framework-free wrapper over the browser's Web Speech recognition API,
 * used by the composer's mic button (T-38, F-21).
 *
 * What this module is, and is not:
 *  - It turns speech into TEXT in the browser. The text lands in the composer
 *    as an ordinary draft which the user reads, edits and sends with the
 *    normal send button; from there it follows the same path as typed text
 *    (server-side redaction, the existing chat route). This module never
 *    calls a model and never makes a network request of its own — whatever
 *    recognition service the browser uses behind `SpeechRecognition` is the
 *    browser's business (Chrome on Android streams the audio to Google), and
 *    that is why the UI shows a visible "listening" line and why dictation is
 *    started only by a click, never automatically.
 *  - The constructor is looked up at CALL time on an injectable window-like
 *    object, not captured at import: the page can lose or gain the API
 *    between renders (permissions, embedded webviews), and Jest, which runs
 *    in Node without a DOM, can pass a fake.
 *
 * The DOM lib that ships with TypeScript 5.9 has the result types but not the
 * recognizer itself, so the few members used here are declared locally (the
 * `@types/dom-speech-recognition` package is deliberately not a dependency).
 */

/** BCP-47 tag handed to the recognizer: Saudi Arabic. */
export const SPEECH_LANG = 'ar-SA';

/** One alternative of one result: the only part of it this module reads. */
interface RecognitionAlternativeLike {
  transcript: string;
}

/** One result (a phrase): array-like of alternatives plus the final flag. */
interface RecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  readonly [index: number]: RecognitionAlternativeLike | undefined;
}

/** The `result` event: `resultIndex` is the first result that changed. */
interface RecognitionResultEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResultLike | undefined;
  };
}

/** The `error` event; `error` is the API's short code, e.g. `not-allowed`. */
interface RecognitionErrorEventLike {
  readonly error?: string;
}

/** The members of a `SpeechRecognition` instance this module touches. */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** A `SpeechRecognition` / `webkitSpeechRecognition` constructor. */
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Cumulative final text plus whatever is still being recognised. */
export interface SpeechUpdate {
  /** Every phrase recognised as final so far in this session, joined by single spaces. */
  finalText: string;
  /** The non-final phrases of the latest event, joined by single spaces; may change or vanish. */
  interimText: string;
}

/** Handle to a running dictation. */
export interface SpeechSession {
  /** Ends recognition gracefully: pending audio is still resolved and `onEnd` follows. */
  stop(): void;
  /** Ends recognition at once and silences this session's callbacks (used on unmount). */
  abort(): void;
}

export type SpeechErrorKind =
  | 'not-allowed'
  | 'no-speech'
  | 'network'
  | 'aborted'
  | 'audio-capture'
  | 'unsupported'
  | 'other';

export interface SpeechHandlers {
  onUpdate(update: SpeechUpdate): void;
  /** Recognition ended, after `stop()` or by itself (silence timeout, error). */
  onEnd(): void;
  onError(kind: SpeechErrorKind): void;
}

/**
 * Finds the recognizer constructor on `win` (default: the global object),
 * preferring the standard name over the `webkit` prefix. Null when neither is
 * a function — Firefox, and any browser with the feature switched off.
 */
export function resolveRecognition(win: unknown = globalThis): SpeechRecognitionCtor | null {
  if (typeof win !== 'object' || win === null) return null;
  const host = win as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const standard = host.SpeechRecognition;
  if (typeof standard === 'function') return standard as SpeechRecognitionCtor;
  const prefixed = host.webkitSpeechRecognition;
  if (typeof prefixed === 'function') return prefixed as SpeechRecognitionCtor;
  return null;
}

/** True when `resolveRecognition` finds a constructor on `win`. */
export function isSpeechSupported(win: unknown = globalThis): boolean {
  return resolveRecognition(win) !== null;
}

/** Maps the API's `error` code to the smaller set the UI distinguishes. */
export function mapSpeechError(code: string | undefined): SpeechErrorKind {
  switch (code) {
    case 'not-allowed':
    // Chrome reports a blocked recognition service the same way.
    case 'service-not-allowed':
      return 'not-allowed';
    case 'no-speech':
      return 'no-speech';
    case 'network':
      return 'network';
    case 'aborted':
      return 'aborted';
    case 'audio-capture':
      return 'audio-capture';
    default:
      return 'other';
  }
}

/** Joins the non-empty trimmed parts with one space. */
function joinParts(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * Creates and starts a recognizer (`ar-SA`, continuous, interim results on,
 * one alternative). Returns null — after calling `onError('unsupported')` —
 * when the browser has no recognizer; also null with `onError('other')` when
 * the constructor or `start()` throws (e.g. a second start on a live
 * instance).
 *
 * Result handling follows the usual pattern: for each event only the results
 * from `event.resultIndex` onward are new or changed, so those marked final
 * are appended to the running final text and the rest form the interim text
 * of that event.
 */
export function startDictation(handlers: SpeechHandlers, win: unknown = globalThis): SpeechSession | null {
  const Ctor = resolveRecognition(win);
  if (!Ctor) {
    handlers.onError('unsupported');
    return null;
  }

  let recognizer: SpeechRecognitionLike;
  try {
    recognizer = new Ctor();
  } catch {
    handlers.onError('other');
    return null;
  }

  let silenced = false;
  const finals: string[] = [];

  recognizer.lang = SPEECH_LANG;
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;

  recognizer.onresult = (event) => {
    if (silenced) return;
    const interim: string[] = [];
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result?.[0]?.transcript;
      if (!result || typeof transcript !== 'string') continue;
      if (result.isFinal) finals.push(transcript);
      else interim.push(transcript);
    }
    handlers.onUpdate({ finalText: joinParts(finals), interimText: joinParts(interim) });
  };
  recognizer.onerror = (event) => {
    if (silenced) return;
    handlers.onError(mapSpeechError(event?.error));
  };
  recognizer.onend = () => {
    if (silenced) return;
    handlers.onEnd();
  };

  try {
    recognizer.start();
  } catch {
    silenced = true;
    handlers.onError('other');
    return null;
  }

  return {
    stop() {
      try {
        recognizer.stop();
      } catch {
        // Already ended: nothing to stop.
      }
    },
    abort() {
      silenced = true;
      try {
        recognizer.abort();
      } catch {
        // Already ended: nothing to abort.
      }
    },
  };
}
