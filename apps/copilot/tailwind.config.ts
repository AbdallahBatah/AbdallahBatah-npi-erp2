import type { Config } from 'tailwindcss';
import webConfig from '../web/tailwind.config';

/**
 * Reuses the web app's design tokens (brand/solar/ink/semantic colors,
 * fontFamily, boxShadow, borderRadius) so the copilot UI never invents its
 * own palette. The only addition is `gold`, the approval-card edge color
 * from the design spec — not part of the shared web theme because it is
 * specific to the copilot's approval-card affordance.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    ...webConfig.theme,
    extend: {
      ...webConfig.theme?.extend,
      colors: {
        ...(webConfig.theme?.extend as { colors?: Record<string, unknown> } | undefined)?.colors,
        gold: '#C9A227',
      },
    },
  },
  plugins: [],
};

export default config;
