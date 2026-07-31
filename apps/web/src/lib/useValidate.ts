'use client';

/**
 * Minimal field validation for controlled forms.
 *
 * Deliberately not react-hook-form: every form in this app already holds its
 * values in useState, and swapping that out would be a rewrite rather than an
 * improvement. This adds the missing half — *when* to show a message.
 *
 * The rule is "don't nag": a field stays silent until the user leaves it
 * (blur) or tries to submit. Validating on every keystroke would flag an
 * email as invalid while it is still being typed.
 */
import { useCallback, useState } from 'react';

/** Returns an error message, or '' / undefined when the value is acceptable. */
export type Rule<T> = (values: T) => string | undefined;
export type Rules<T> = Partial<Record<keyof T & string, Rule<T>>>;

export function useValidate<T extends Record<string, unknown>>(values: T, rules: Rules<T>) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);

  /** All current violations, regardless of whether they are shown yet. */
  const errors: Record<string, string> = {};
  for (const key of Object.keys(rules)) {
    const msg = rules[key as keyof T & string]?.(values);
    if (msg) errors[key] = msg;
  }

  const isValid = Object.keys(errors).length === 0;

  /** The message to render for a field — empty until it has been touched. */
  const errorOf = useCallback(
    (key: keyof T & string): string | undefined =>
      touched[key] || submitted ? errors[key] : undefined,
    // errors is rebuilt every render by design; depending on it directly would
    // defeat the memo without changing behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [touched, submitted, JSON.stringify(errors)],
  );

  const onBlur = useCallback((key: keyof T & string) => {
    setTouched((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);

  /**
   * Call at the top of a submit handler. Reveals every message and reports
   * whether it is safe to continue.
   */
  const validateAll = useCallback(() => {
    setSubmitted(true);
    return isValid;
  }, [isValid]);

  const reset = useCallback(() => {
    setTouched({});
    setSubmitted(false);
  }, []);

  return { errorOf, onBlur, validateAll, reset, isValid, errors };
}
