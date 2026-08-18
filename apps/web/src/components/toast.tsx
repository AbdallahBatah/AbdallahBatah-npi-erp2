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
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 start-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-white p-3.5 text-sm leading-6 shadow-card ${
              t.kind === 'success'
                ? 'border-emerald-200 text-emerald-800'
                : 'border-rose-200 text-rose-700'
            }`}
          >
            <span
              className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                t.kind === 'success' ? 'bg-emerald-500' : 'bg-rose-500'
              }`}
            />
            <span className="flex-1">{t.text}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="إغلاق"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
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
