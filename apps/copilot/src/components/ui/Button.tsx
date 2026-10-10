'use client';

import { ButtonHTMLAttributes, forwardRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the icon slot and marks the button busy/disabled. */
  loading?: boolean;
}

// The quiet, shared disabled look for every variant — always listed last so
// it wins over each variant's own hover/background utilities (same
// specificity, so source order decides). `disabled:bg-none` is what actually
// drops the primary gradient; `disabled:bg-slate-200` alone would just sit
// under it.
const DISABLED_CLASSES =
  'disabled:bg-none disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Copies NPI's `.btn-primary` recipe (apps/web/src/app/globals.css).
  primary: `bg-gradient-to-b from-brand-600 to-brand-700 text-white shadow-sm shadow-brand-700/25 hover:from-brand-500 hover:to-brand-600 focus-visible:ring-brand-400 ${DISABLED_CLASSES}`,
  secondary: `border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus-visible:ring-brand-500 ${DISABLED_CLASSES} disabled:border-slate-200`,
  danger: `bg-danger-600 text-white hover:bg-danger-700 focus-visible:ring-danger-500 ${DISABLED_CLASSES}`,
  ghost: `bg-transparent text-slate-700 hover:bg-slate-100 focus-visible:ring-brand-500 ${DISABLED_CLASSES}`,
};

// `sm` still hits the 44px touch target on mobile (below `md`); it only
// shrinks to a compact 36px control at desktop widths.
const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-11 md:h-9 min-w-11 gap-1.5 px-3 text-xs',
  md: 'h-11 min-w-11 gap-2 px-4 text-sm',
};

/** Inline spinner, sized to whatever text/icon slot it replaces. */
export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      className={`${className} animate-spin motion-reduce:animate-none`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled,
    className = '',
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        'inline-flex items-center justify-center rounded-lg font-semibold transition',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {loading ? <Spinner className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} /> : null}
      {children}
    </button>
  );
});
