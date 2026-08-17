'use client';

import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { messages, type Locale } from './messages';

/**
 * Native constraint-validation bubbles ("Please fill out this field.") speak
 * the browser's language, not the app's. Localize them by kind; clearing on
 * input lets the browser re-validate the corrected value.
 */
function validationMessage(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, l: Locale): string {
  const v = el.validity;
  const ar = l === 'ar';
  if (v.valueMissing) return ar ? 'هذا الحقل مطلوب' : 'This field is required';
  if (v.typeMismatch) return ar ? 'أدخل قيمة صحيحة بهذه الصيغة' : 'Enter a valid value for this format';
  if (v.rangeUnderflow || v.rangeOverflow || v.stepMismatch)
    return ar ? 'القيمة خارج النطاق المسموح' : 'Value is out of the allowed range';
  if (v.tooShort || v.tooLong) return ar ? 'طول القيمة غير مقبول' : 'Value length is not acceptable';
  if (v.patternMismatch) return ar ? 'القيمة لا تطابق الصيغة المطلوبة' : 'Value does not match the required format';
  return ar ? 'قيمة غير صالحة' : 'Invalid value';
}

interface I18nValue {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  t: (key: string) => string;
  /** Pick the Arabic or English value of a paired *_ar / *_en record. */
  pick: (row: Record<string, any>, base: string) => string;
  setLocale: (l: Locale) => void;
  toggle: () => void;
}

const I18nContext = createContext<I18nValue | null>(null);

function writeLocaleCookie(l: Locale) {
  document.cookie = `locale=${l}; path=/; max-age=31536000`;
}

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    const isFormControl = (
      t: EventTarget | null,
    ): t is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
      t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
    // 'invalid' does not bubble — capture is the only way to delegate it.
    const onInvalid = (e: Event) => {
      if (isFormControl(e.target)) e.target.setCustomValidity(validationMessage(e.target, locale));
    };
    // A custom message marks the field invalid until cleared; wipe it on any
    // edit so the browser re-runs the real constraints on the new value.
    const onInput = (e: Event) => {
      if (isFormControl(e.target)) e.target.setCustomValidity('');
    };
    document.addEventListener('invalid', onInvalid, true);
    document.addEventListener('input', onInput, true);
    return () => {
      document.removeEventListener('invalid', onInvalid, true);
      document.removeEventListener('input', onInput, true);
    };
  }, [locale]);

  const value = useMemo<I18nValue>(() => {
    const setLocale = (l: Locale) => {
      writeLocaleCookie(l);
      setLocaleState(l);
      if (typeof document !== 'undefined') {
        document.documentElement.lang = l;
        document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
      }
    };
    return {
      locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      t: (key: string) => messages[locale][key] ?? key,
      pick: (row, base) =>
        (locale === 'ar' ? row?.[`${base}Ar`] : row?.[`${base}En`]) ??
        row?.[`${base}En`] ??
        row?.[`${base}Ar`] ??
        '',
      setLocale,
      toggle: () => setLocale(locale === 'ar' ? 'en' : 'ar'),
    };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
