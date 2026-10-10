// End-to-end coverage for T-19 (the settings screen, F-15). Real local NPI
// API + real copilot, real login — same shape as `e2e/setup.spec.ts`. Every
// test seeds a completed epc configuration via `settings-db.ts` and restores
// the org's prior state in `afterEach`, so tests stay independent of one
// another and of whatever a developer's own `/setup` run left behind. Runs
// on both the `desktop` and `mobile` Playwright projects.
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t, type ArKey } from '../src/i18n/ar';
import { formatNumber } from '../src/i18n/format';
import { loadProfilePack } from '../src/onboarding/catalog';
import { APPROVAL_DOCUMENT_LABEL_AR } from '../src/onboarding/plan';
import { FLOW_TYPES } from '../src/onboarding/profile.schema';
import { readAdminCredentials, readSiteEngineerCredentials, type SeededAccount } from './fixtures/accounts';
import { waitForHydration } from './fixtures/hydration';
import { disconnectSetupDb } from './fixtures/setup-db';
import {
  deleteFirmConfig,
  disconnectSettingsDb,
  restoreSettingsFixture,
  seedSettingsFixture,
  type SettingsFixtureHandle,
} from './fixtures/settings-db';

const API_PORT = process.env.COPILOT_E2E_API_PORT ?? '4077';
const API_BASE = `http://localhost:${API_PORT}/api`;

async function npiOrgId(request: APIRequestContext, account: SeededAccount): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { email: account.email, password: account.password } });
  expect(res.ok(), `NPI login failed for ${account.email}`).toBe(true);
  const body = (await res.json()) as { user: { organization: { id: string } } };
  return body.user.organization.id;
}

async function signIn(page: Page, account: SeededAccount): Promise<void> {
  await page.goto('/copilot/login');
  await page.getByLabel(t('login.email')).fill(account.email);
  await page.getByLabel(t('login.password')).fill(account.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
  await waitForHydration(page);
}

const epcPack = loadProfilePack('epc');

test.describe('settings screen (T-19)', () => {
  // Several of these tests save, then reload, then re-assert — real round
  // trips through the dev server on every step — longer than the default
  // 30s under a loaded machine.
  test.describe.configure({ timeout: 60000 });

  let orgId: string;
  let handle: SettingsFixtureHandle;

  test.beforeEach(async ({ request }) => {
    const admin = readAdminCredentials();
    orgId = await npiOrgId(request, admin);
    handle = await seedSettingsFixture(orgId);
  });

  test.afterEach(async () => {
    await restoreSettingsFixture(handle);
  });

  test.afterAll(async () => {
    await disconnectSettingsDb();
    await disconnectSetupDb();
  });

  test('admin sees the epc configuration, its modules, doc types, terminology and the blocked leftover', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.settings') })).toBeVisible();

    await page.goto('/copilot/settings');

    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: t('settings.title') })).toBeVisible();
    await expect(page.getByText(t('profile.epc'))).toBeVisible();

    const docTypesCard = page.getByTestId('settings-doctypes-card');
    for (const docType of epcPack.acceptedDocTypes) {
      await expect(docTypesCard.getByText(docType.labelAr, { exact: false }).first()).toBeVisible();
    }
    await expect(page.getByTestId('settings-doctypes-card').getByText(t('flow.customer_contract'))).toBeVisible();

    await expect(page.getByTestId('settings-terminology-card').getByText('عقد EPC')).toBeVisible();

    for (const key of ['crm', 'commercial', 'projects', 'procurement', 'finance'] as const) {
      await expect(page.getByTestId(`settings-module-${key}`)).toBeChecked();
    }
    for (const key of ['ppa', 'telemetry'] as const) {
      await expect(page.getByTestId(`settings-module-${key}`)).not.toBeChecked();
    }
    await expect(page.getByTestId('settings-module-finance')).toBeDisabled();

    const leftoverLabel = t('settings.leftover.approval_rule', {
      doc: APPROVAL_DOCUMENT_LABEL_AR.PURCHASE_ORDER,
      min: formatNumber(100000),
    });
    await expect(page.getByText(leftoverLabel)).toBeVisible();
  });

  test('a non-admin sees settings.forbidden and no nav.settings item', async ({ page }) => {
    const engineer = readSiteEngineerCredentials();
    await signIn(page, engineer);

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.settings') })).toHaveCount(0);

    await page.goto('/copilot/settings');

    await waitForHydration(page);
    await expect(page.getByText(t('settings.forbidden'))).toBeVisible();
  });

  test('unchecking procurement names the flows it hides, persists on save, and tags doc types on reload', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/settings');
    await waitForHydration(page);

    const procurementCheckbox = page.getByTestId('settings-module-procurement');
    await expect(procurementCheckbox).toBeChecked();
    await procurementCheckbox.uncheck();

    const hiddenFlows = ['pr', 'po', 'grn', 'vendor_bill'] as const;
    const hint = t('settings.modules.hides_flows', {
      flows: hiddenFlows.map((f) => t(`flow.${f}`)).join('، '),
    });
    await expect(page.getByText(hint)).toBeVisible();

    await page.getByRole('button', { name: t('settings.modules.save') }).click();
    await expect(page.getByText(t('settings.modules.saved'))).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('settings-module-procurement')).not.toBeChecked();

    const procurementDocTypes = epcPack.acceptedDocTypes.filter(
      (d) => d.flow !== null && hiddenFlows.includes(d.flow as (typeof hiddenFlows)[number]),
    );
    expect(procurementDocTypes.length).toBeGreaterThan(0);
    // Only the procurement-flow doc types should carry the warning badge —
    // the commercial-flow one (epc_contract) must not.
    await expect(page.getByTestId('settings-doctypes-card').getByText(t('settings.doc_types.hidden_module'))).toHaveCount(
      procurementDocTypes.length,
    );
  });

  test('a baseline is validated client-side, saved, and survives a reload', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/settings');
    await waitForHydration(page);

    const row = page.getByTestId('settings-baseline-customer_contract');
    await expect(row.getByText(t('settings.baselines.none'))).toBeVisible();

    const input = row.getByRole('spinbutton');
    const saveButton = row.getByRole('button', { name: t('settings.baselines.save') });

    let requestCount = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/copilot/api/settings')) requestCount += 1;
    });

    await input.fill('0');
    await saveButton.click();
    await expect(row.getByText(t('settings.baselines.invalid', { min: formatNumber(1), max: formatNumber(600) }))).toBeVisible();
    expect(requestCount).toBe(0);

    await input.fill('25');
    await saveButton.click();
    await expect(row.getByText(t('settings.baselines.saved'))).toBeVisible();
    await expect(row.getByText('25', { exact: false })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('settings-baseline-customer_contract').getByText('25', { exact: false })).toBeVisible();
  });

  test('rerunning the doc types step lands on step 4 of the wizard with every step reachable', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/settings');
    await waitForHydration(page);

    await page.getByTestId('settings-doctypes-card').getByRole('button', { name: t('settings.rerun') }).click();

    await page.waitForURL('**/copilot/setup');
    await expect(page.getByRole('heading', { name: t('setup.q4') })).toBeVisible();
    await expect(page.getByText(t('setup.step_of', { n: 4, total: 7 }))).toBeVisible();

    for (let n = 1; n <= 7; n += 1) {
      await expect(page.getByRole('button', { name: `${n} ${t(`setup.step.${n}` as ArKey)}` })).toBeEnabled();
    }
  });

  test('with no firm_config, settings.no_config and settings.go_setup show, and the baselines card stays', async ({ page }) => {
    await deleteFirmConfig(orgId);

    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/settings');
    await waitForHydration(page);

    await expect(page.getByText(t('settings.no_config'))).toBeVisible();
    await expect(page.getByRole('link', { name: t('settings.go_setup') })).toBeVisible();
    await expect(page.getByText(t('settings.baselines'))).toBeVisible();
    for (const flow of FLOW_TYPES) {
      await expect(page.getByTestId(`settings-baseline-${flow}`)).toBeVisible();
    }
  });
});
