import {
  SPEECH_LANG,
  isSpeechSupported,
  mapSpeechError,
  resolveRecognition,
  startDictation,
  type SpeechErrorKind,
  type SpeechHandlers,
  type SpeechUpdate,
} from '@/voice/speech';

// Jest runs in Node with no DOM: the recognizer is a fake class injected as
// the "window".

interface FakeResult {
  text: string;
  isFinal: boolean;
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  throwOnStart = false;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    if (this.throwOnStart) throw new Error('InvalidStateError');
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
  abort(): void {
    this.aborted += 1;
  }

  /** Dispatches a result event the way the browser shapes it. */
  emit(resultIndex: number, results: FakeResult[]): void {
    const list = results.map((r) => ({ 0: { transcript: r.text, confidence: 0.9 }, length: 1, isFinal: r.isFinal }));
    this.onresult?.({ resultIndex, results: Object.assign(list, { length: list.length }) });
  }
  fail(code: string): void {
    this.onerror?.({ error: code });
  }
  finish(): void {
    this.onend?.();
  }
}

class FakeWebkitRecognition extends FakeRecognition {}

interface Recorder {
  handlers: SpeechHandlers;
  updates: SpeechUpdate[];
  errors: SpeechErrorKind[];
  ends: number;
}

function recorder(): Recorder {
  const rec: Recorder = {
    updates: [],
    errors: [],
    ends: 0,
    handlers: {
      onUpdate: (u) => rec.updates.push(u),
      onEnd: () => {
        rec.ends += 1;
      },
      onError: (k) => rec.errors.push(k),
    },
  };
  return rec;
}

beforeEach(() => {
  FakeRecognition.instances = [];
});

describe('resolveRecognition / isSpeechSupported', () => {
  it('prefers the standard constructor over the webkit one', () => {
    const win = { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: FakeWebkitRecognition };
    expect(resolveRecognition(win)).toBe(FakeRecognition);
  });

  it('falls back to the webkit constructor', () => {
    expect(resolveRecognition({ webkitSpeechRecognition: FakeWebkitRecognition })).toBe(FakeWebkitRecognition);
  });

  it('returns null when neither exists or the value is not a function', () => {
    expect(resolveRecognition({})).toBeNull();
    expect(resolveRecognition({ SpeechRecognition: 'nope' })).toBeNull();
    expect(resolveRecognition(null)).toBeNull();
    expect(resolveRecognition(undefined as unknown)).toBeNull();
  });

  it('reports support from the same lookup, at call time', () => {
    const win: { SpeechRecognition?: unknown } = {};
    expect(isSpeechSupported(win)).toBe(false);
    win.SpeechRecognition = FakeRecognition;
    expect(isSpeechSupported(win)).toBe(true);
  });
});

describe('startDictation', () => {
  it('is unsupported without a constructor: null plus onError("unsupported")', () => {
    const rec = recorder();
    expect(startDictation(rec.handlers, {})).toBeNull();
    expect(rec.errors).toEqual(['unsupported']);
    expect(rec.updates).toEqual([]);
  });

  it('configures Saudi Arabic, continuous with interim results, and starts', () => {
    const rec = recorder();
    const session = startDictation(rec.handlers, { SpeechRecognition: FakeRecognition });
    expect(session).not.toBeNull();
    const [instance] = FakeRecognition.instances;
    expect(instance.lang).toBe(SPEECH_LANG);
    expect(SPEECH_LANG).toBe('ar-SA');
    expect(instance.continuous).toBe(true);
    expect(instance.interimResults).toBe(true);
    expect(instance.maxAlternatives).toBe(1);
    expect(instance.started).toBe(1);
  });

  it('accumulates two final results and reports the interim of the latest event', () => {
    const rec = recorder();
    startDictation(rec.handlers, { SpeechRecognition: FakeRecognition });
    const [instance] = FakeRecognition.instances;

    instance.emit(0, [{ text: 'أبي 40 لوح', isFinal: false }]);
    expect(rec.updates.at(-1)).toEqual({ finalText: '', interimText: 'أبي 40 لوح' });

    instance.emit(0, [{ text: ' أبي 40 لوح 550 واط', isFinal: true }]);
    expect(rec.updates.at(-1)).toEqual({ finalText: 'أبي 40 لوح 550 واط', interimText: '' });

    // Results 0 is already final; the browser reports resultIndex 1 for the next phrase.
    instance.emit(1, [
      { text: ' أبي 40 لوح 550 واط', isFinal: true },
      { text: 'للمشروع PRJ-00012', isFinal: true },
    ]);
    expect(rec.updates.at(-1)).toEqual({
      finalText: 'أبي 40 لوح 550 واط للمشروع PRJ-00012',
      interimText: '',
    });

    instance.emit(2, [
      { text: 'x', isFinal: true },
      { text: 'y', isFinal: true },
      { text: 'قبل الخميس', isFinal: false },
    ]);
    expect(rec.updates.at(-1)).toEqual({
      finalText: 'أبي 40 لوح 550 واط للمشروع PRJ-00012',
      interimText: 'قبل الخميس',
    });
  });

  it('ignores results without a transcript instead of throwing', () => {
    const rec = recorder();
    startDictation(rec.handlers, { SpeechRecognition: FakeRecognition });
    const [instance] = FakeRecognition.instances;
    instance.onresult?.({ resultIndex: 0, results: { length: 1, 0: { length: 0, isFinal: true } } });
    expect(rec.updates.at(-1)).toEqual({ finalText: '', interimText: '' });
  });

  it('stop() calls the recognizer stop and onEnd follows when the recognizer ends', () => {
    const rec = recorder();
    const session = startDictation(rec.handlers, { webkitSpeechRecognition: FakeWebkitRecognition });
    const [instance] = FakeRecognition.instances;
    session?.stop();
    expect(instance.stopped).toBe(1);
    expect(rec.ends).toBe(0);
    instance.finish();
    expect(rec.ends).toBe(1);
  });

  it('abort() calls the recognizer abort and silences every later callback', () => {
    const rec = recorder();
    const session = startDictation(rec.handlers, { SpeechRecognition: FakeRecognition });
    const [instance] = FakeRecognition.instances;
    session?.abort();
    expect(instance.aborted).toBe(1);
    instance.emit(0, [{ text: 'متأخر', isFinal: true }]);
    instance.fail('network');
    instance.finish();
    expect(rec.updates).toEqual([]);
    expect(rec.errors).toEqual([]);
    expect(rec.ends).toBe(0);
  });

  it('maps API error codes to the UI kinds', () => {
    const rec = recorder();
    startDictation(rec.handlers, { SpeechRecognition: FakeRecognition });
    const [instance] = FakeRecognition.instances;
    for (const code of ['not-allowed', 'service-not-allowed', 'no-speech', 'network', 'aborted', 'audio-capture', 'language-not-supported', 'bad-grammar']) {
      instance.fail(code);
    }
    expect(rec.errors).toEqual([
      'not-allowed',
      'not-allowed',
      'no-speech',
      'network',
      'aborted',
      'audio-capture',
      'other',
      'other',
    ]);
  });

  it('reports "other" and returns null when start() throws', () => {
    class Throwing extends FakeRecognition {
      throwOnStart = true;
    }
    const rec = recorder();
    expect(startDictation(rec.handlers, { SpeechRecognition: Throwing })).toBeNull();
    expect(rec.errors).toEqual(['other']);
  });

  it('reports "other" and returns null when the constructor throws', () => {
    class Broken {
      constructor() {
        throw new Error('boom');
      }
    }
    const rec = recorder();
    expect(startDictation(rec.handlers, { SpeechRecognition: Broken })).toBeNull();
    expect(rec.errors).toEqual(['other']);
  });
});

describe('mapSpeechError', () => {
  it('maps undefined to other', () => {
    expect(mapSpeechError(undefined)).toBe('other');
  });
});
