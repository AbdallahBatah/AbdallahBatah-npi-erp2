import type { Locale } from './messages';

/**
 * Journal memos are written in English by the posting services (and are part of
 * the immutable audit trail, so they are not rewritten in the database). The
 * ledger view translates the known shapes for Arabic readers — same approach as
 * `translateError`. Anything unrecognised is shown verbatim.
 */
const PATTERNS: Array<{ re: RegExp; ar: (m: RegExpMatchArray) => string }> = [
  {
    re: /^Milestone invoice (\S+)$/i,
    ar: (m) => `فاتورة مرحلة ${m[1]}`,
  },
  {
    re: /^Payment (\S+) for (\S+)$/i,
    ar: (m) => `سند قبض ${m[1]} عن الفاتورة ${m[2]}`,
  },
  {
    re: /^Retention release for (\S+)$/i,
    ar: (m) => `الإفراج عن محتجزات الفاتورة ${m[1]}`,
  },
  {
    re: /^IFRS-15 POC adjustment for (\S+) \(progress ([\d.]+)%\)$/i,
    ar: (m) => `تسوية الاعتراف بالإيراد — العقد ${m[1]} (نسبة الإنجاز ${m[2]}%)`,
  },
  {
    re: /^Vendor bill (\S+) — (.+) \((\S+)\)$/i,
    ar: (m) => `فاتورة مورد ${m[1]} — ${m[2]} (إشعار الاستلام ${m[3]})`,
  },
  {
    re: /^Progress claim (\S+) — (.+)$/i,
    ar: (m) => `مستخلص مقاول باطن ${m[1]} — ${m[2]}`,
  },
];

export function translateMemo(memo: string | null | undefined, locale: Locale): string {
  if (!memo) return '';
  if (locale !== 'ar') return memo;
  for (const p of PATTERNS) {
    const m = memo.match(p.re);
    if (m) return p.ar(m);
  }
  return memo;
}
