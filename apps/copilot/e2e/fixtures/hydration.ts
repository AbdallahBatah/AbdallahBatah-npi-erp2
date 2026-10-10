// Since T-39b the screens render their content on the server: a button is on
// the page before React has hydrated it, and a click in that window does
// nothing. Every helper that lands on a screen waits for the mark
// `src/components/HydrationMark.tsx` sets before the test interacts.
import type { Page } from '@playwright/test';

export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForSelector('html[data-hydrated]', { state: 'attached', timeout: 60_000 });
}
