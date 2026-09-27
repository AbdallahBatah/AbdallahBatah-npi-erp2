// End-to-end coverage for fix 2 (design-critique pass): the Arabic
// not-found page. Real local NPI API + real copilot, real login.
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { readAdminCredentials } from './fixtures/accounts';

// A crude but effective "no stray Latin sentence" check — mirrors the intent
// of the app-wide `no-latin-ui-text` lint rule, applied here to the rendered
// page text rather than the JSX source. Document codes / NPI are allowed the
// same way `tests/i18n.spec.ts` allows them.
const ALLOWED_WORD_TOKENS = new Set(['NPI', 'CSV', 'EPC', 'PPA']);
const ALLOWED_CODE_RE = /^[A-Z]{2,4}-\d+$/;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9-]*/g;

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  const { email, password } = readAdminCredentials();
  await page.goto('/copilot/login');
  await page.getByLabel(t('login.email')).fill(email);
  await page.getByLabel(t('login.password')).fill(password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
}

test.describe('not-found page', () => {
  test('shows the Arabic message, no Latin sentence, and a link home', async ({ page }) => {
    await signIn(page);

    await page.goto('/copilot/no-such-page');

    await expect(page.getByRole('heading', { name: t('notfound.title') })).toBeVisible();
    await expect(page.getByText(t('notfound.body'))).toBeVisible();

    const bodyText = await page.locator('body').innerText();
    const offenders = (bodyText.match(LATIN_WORD_RE) ?? []).filter(
      (word) => !ALLOWED_WORD_TOKENS.has(word) && !ALLOWED_CODE_RE.test(word),
    );
    expect(offenders).toEqual([]);

    const homeLink = page.getByRole('link', { name: t('nav.home') });
    await expect(homeLink).toBeVisible();
    await homeLink.click();
    await page.waitForURL('**/copilot');
    expect(new URL(page.url()).pathname).toBe('/copilot');
  });
});
