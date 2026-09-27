import { ReactNode } from 'react';
import { t } from '@/i18n/ar';
import { Button, Spinner } from './Button';

/** Empty-state placeholder: a message plus optional chips/actions below it.
 *  Uses the same card-like surface as the rest of the app (NPI does not use
 *  a dashed-border placeholder pattern). */
export function EmptyState({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-8 text-center shadow-card">
      <p className="text-sm text-slate-600">{message}</p>
      {children}
    </div>
  );
}

/** Error-state card. `onRetry`, when given, renders a `t('action.retry')` button. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-danger-200 bg-danger-50/40 p-8 text-center"
    >
      <p className="text-sm text-danger-700">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('action.retry')}
        </Button>
      ) : null}
    </div>
  );
}

/** A single skeleton block. Pulse animation is dropped under reduced motion. */
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`rounded-md bg-slate-200 motion-safe:animate-pulse motion-reduce:animate-none ${className}`}
    />
  );
}

/** Whole-region loading indicator, announced to assistive tech via `role="status"`. */
export function LoadingState() {
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-slate-600">
      <Spinner className="h-4 w-4" />
      {t('state.loading')}
    </div>
  );
}
