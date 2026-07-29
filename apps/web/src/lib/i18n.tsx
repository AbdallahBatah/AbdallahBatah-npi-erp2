'use client';

import { createContext, useContext, useMemo, useState, ReactNode } from 'react';
import { messages, type Locale } from './messages';

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
