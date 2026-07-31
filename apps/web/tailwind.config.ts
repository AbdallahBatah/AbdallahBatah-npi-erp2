import type { Config } from 'tailwindcss';
import colors from 'tailwindcss/colors';

/**
 * Typography scale — deliberately capped at four sizes for the whole app:
 *   text-xs  (11–12px) labels, table headers, hints
 *   text-sm  (14px)    body, table cells, buttons, inputs   ← the default
 *   text-lg  (18px)    card/section headings
 *   text-3xl (30px)    KPI figures only
 * Anything else is a bug: pick the nearest of these four.
 *
 * Font: IBM Plex Sans Arabic (self-hosted via next/font in app/layout.tsx).
 * Numbers render with Western digits everywhere, including the Arabic UI —
 * see the `ar-SA-u-nu-latn` pin in lib/format.ts. Both are settled decisions.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Semantic roles ──────────────────────────────────────────────
        // One meaning per colour, applied system-wide. Use these — not raw
        // emerald/rose/amber/sky — so a status never reads differently on
        // two screens.
        //   success → approve, post, save, healthy
        //   danger  → cancel, delete, reject, loss, overdue
        //   warning → pending, awaiting action, degraded
        //   info    → neutral in-progress / informational
        success: colors.emerald,
        danger: colors.rose,
        warning: colors.amber,
        info: colors.sky,
        // Deep professional teal — energy + trust, distinct from generic blue.
        brand: {
          50: '#f0fdfa',
          100: '#ccfbf1',
          200: '#99f6e4',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
          950: '#042f2e',
        },
        // Solar amber accent.
        solar: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
        },
        // Sidebar surface (deep desert night).
        ink: {
          800: '#101826',
          900: '#0b111d',
          950: '#070b14',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'Segoe UI', 'Tahoma', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        'card-hover': '0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 6px -2px rgb(15 23 42 / 0.05)',
        glow: '0 0 40px -8px rgb(20 184 166 / 0.45)',
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
    },
  },
  plugins: [],
};

export default config;
