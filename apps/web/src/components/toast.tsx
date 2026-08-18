'use client';

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { Icon } from '@/components/icons';
import { useI18n } from '@/lib/i18n';

interface Toast {
  id: number;
  kind: 'success' | 'error';
  text: string;
}

interface ToastValue {
  success: (text: string) => void;
  error: (text: string) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  // ToastProvider mounts inside I18nProvider, so the close button has no
  // reason to be labelled in hardcoded Arabic for English users.
  const { t: tr } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: Toast['kind'], text: string) => {
      const id = ++seq.current;
      setToasts((ts) => [...ts.slice(-4), { id, kind, text }]);
      // Errors linger longer so a slow reader can finish them.
      window.setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );

  const value = useRef<ToastValue>({
    success: (text) => push('success', text),
    error: (text) => push('error', text),
  });
  value.current.success = (text) => push('success', text);
  value.current.error = (text) => push('error', text);

  return (
    <ToastContext.Provider value={value.current}>
      {children}
      {/* A single always-mounted live region. Each toast used to carry its own
          role="alert"/"status" INSIDE this one, and nesting live regions is
          undefined — screen readers double-announce or drop the inner one. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 start-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-white p-3.5 text-sm leading-6 shadow-card ${
              t.kind === 'success'
                ? 'border-success-200 text-success-800'
                : 'border-danger-200 text-danger-700'
            }`}
          >
            {/* Shape, not just hue: the dot made success and error identical
                for a red/green-deficient reader. */}
            <Icon
              name={t.kind === 'success' ? 'check-circle' : 'alert-triangle'}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span className="flex-1">{t.text}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label={tr('common.close')}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
