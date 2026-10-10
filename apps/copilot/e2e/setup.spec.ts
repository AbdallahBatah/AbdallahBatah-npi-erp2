// End-to-end coverage for T-18 (the setup screens). Real local NPI API + real
// copilot, real login. `preview` is a live, read-only dry-run against the
// local NPI; `apply` is always intercepted (a live apply writes to NPI and
// belongs to T-20); free-text answers only ever use sentences
// `src/onboarding/parse.ts` resolves deterministically, so no test calls the
// real model. Runs on both the `desktop` and `mobile` Playwright projects.
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t } from '../src/i18n/ar';
import { formatNumber } from '../src/i18n/format';
import { readAdminCredentials, readSiteEngineerCredentials, type SeededAccount } from './fixtures/accounts';
import { waitForHydration } from './fixtures/hydration';
import { disconnectSetupDb, resetOpenSetupSessions } from './fixtures/setup-db';

const API_PORT = process.env.COPILOT_E2E_API_PORT ?? '4077';
const API_BASE = `http://localhost:${API_PORT}/api`;
const SETUP_PATH = '**/copilot/api/setup';

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

function jsonRoute(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Fills the step's free-text composer and sends it. Waits for the textarea
 *  to actually hold the typed value before clicking — under a loaded dev
 *  server, `fill()` can race a React remount of the step (e.g. a just-saved
 *  answer re-rendering the frame) and land on a textarea that is about to be
 *  thrown away, which otherwise shows up as the send button never leaving
 *  its disabled state. */
async function sendFreeText(page: Page, text: string): Promise<void> {
  const textarea = page.getByLabel(t('setup.free_text'));
  await expect(textarea).toBeEditable();
  await textarea.fill(text);
  await expect(textarea).toHaveValue(text);
  await page.getByRole('button', { name: t('chat.send') }).click();
}

async function postedBody(route: Route): Promise<Record<string, unknown>> {
  return (route.request().postDataJSON() as Record<string, unknown>) ?? {};
}

/** Waits specifically for the `action: 'preview'` response — set up *before*
 *  the action that triggers it (SetupWizard's step-7 effect fires it right
 *  after the last answer's own response lands), never awaited right after
 *  the triggering click, so it cannot race an earlier in-flight `answer`
 *  response to the same URL. */
function waitForPreviewResponse(page: Page) {
  return page.waitForResponse((res) => {
    if (res.request().method() !== 'POST' || !res.url().includes('/copilot/api/setup')) return false;
    try {
      const body = res.request().postDataJSON() as Record<string, unknown> | null;
      return body?.action === 'preview';
    } catch {
      return false;
    }
  });
}

interface PlanStepLike {
  id: string;
  kind: string;
  action: 'create' | 'update' | 'skip' | 'blocked';
  permissionsRemoved?: string[];
}

interface PreviewBody {
  plan: { steps: PlanStepLike[]; counts: { create: number; update: number; skip: number; blocked: number } };
  summary: { npi: string[]; already: string[]; copilot: string[]; blocked: string[]; gaps: string[] };
}

test.describe('setup screens (T-18)', () => {
  // Several of these tests walk the wizard through multiple sequential
  // steps, each a real round trip to the copilot's dev server (and, for the
  // preview, to NPI) — longer than the default 30s under a loaded machine.
  test.describe.configure({ timeout: 60000 });

  test.beforeEach(async ({ request }) => {
    // Admin and the seeded site engineer share one organization in the demo
    // seed, so resetting by the admin's org clears any open session
    // regardless of which account a given test signs in with.
    const admin = readAdminCredentials();
    const orgId = await npiOrgId(request, admin);
    await resetOpenSetupSessions(orgId);
  });

  test.afterAll(async () => {
    await disconnectSetupDb();
  });

  test('admin opens /setup and sees the title, the 7-step stepper, step 1, and the nav link', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.setup') })).toBeVisible();

    await page.goto('/copilot/setup');

    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: t('setup.title') })).toBeVisible();
    await expect(page.getByRole('heading', { name: t('setup.q1') })).toBeVisible();
    await expect(page.getByText(t('setup.step_of', { n: 1, total: 7 }))).toBeVisible();
    await expect(page.locator('ol li')).toHaveCount(7);
  });

  test('a non-admin sees setup.forbidden and no nav.setup item', async ({ page }) => {
    const engineer = readSiteEngineerCredentials();
    await signIn(page, engineer);

    const nav = page.getByRole('navigation', { name: t('nav.main') });
    await expect(nav.getByRole('link', { name: t('nav.setup') })).toHaveCount(0);

    await page.goto('/copilot/setup');

    await waitForHydration(page);
    await expect(page.getByText(t('setup.forbidden'))).toBeVisible();
  });

  test('step 1 by free text lands on step 2 with the epc departments and a holder for the admin position', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/setup');
    await waitForHydration(page);

    await sendFreeText(page, 'إحنا مقاول EPC');

    await expect(page.getByRole('heading', { name: t('setup.q2') })).toBeVisible();
    await expect(page.getByTestId('setup-dept-SALES').getByLabel(t('setup.dept.name'))).toHaveValue('المبيعات');
    await expect(page.getByTestId('setup-dept-PROJ').getByLabel(t('setup.dept.name'))).toHaveValue('المشاريع');

    // The admin position (roleKey "admin") lists the seeded admin as an
    // available holder.
    await expect(page.getByRole('checkbox', { name: admin.nameAr })).toBeVisible();
    await expect(page.getByText(t('setup.holders.note'))).toBeVisible();
  });

  test('step 2 structured edits persist across a goto back to step 2, and step 3 shows the epc rules', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/setup');
    await waitForHydration(page);

    await sendFreeText(page, 'إحنا مقاول EPC');
    await expect(page.getByRole('heading', { name: t('setup.q2') })).toBeVisible();

    const salesRow = page.getByTestId('setup-dept-SALES');
    const salesName = salesRow.getByLabel(t('setup.dept.name'));
    await salesName.fill('قسم المبيعات والتسويق');

    const adminHolder = page.getByRole('checkbox', { name: admin.nameAr });
    await adminHolder.check();

    await page.getByRole('button', { name: t('setup.save_step') }).click();
    await expect(page.getByRole('heading', { name: t('setup.q3') })).toBeVisible();
    await expect(page.getByTestId('setup-rule')).toHaveCount(3);

    // Go back via the stepper to step 2 and confirm the edit and the
    // holder checkbox both survived the round trip through the server.
    await page.getByRole('button', { name: `2 ${t('setup.step.2')}` }).click();
    await expect(page.getByRole('heading', { name: t('setup.q2') })).toBeVisible();
    await expect(page.getByTestId('setup-dept-SALES').getByLabel(t('setup.dept.name'))).toHaveValue('قسم المبيعات والتسويق');
    await expect(page.getByRole('checkbox', { name: admin.nameAr })).toBeChecked();
  });

  test('steps 3-6 accepted by text reach step 7, where a live preview renders the diff card', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/setup');
    await waitForHydration(page);

    await sendFreeText(page, 'إحنا مقاول EPC');
    await expect(page.getByRole('heading', { name: t('setup.q2') })).toBeVisible();
    await page.getByRole('button', { name: t('setup.save_step') }).click();
    await expect(page.getByRole('heading', { name: t('setup.q3') })).toBeVisible();

    const previewResponsePromise = waitForPreviewResponse(page);
    for (const q of ['setup.q3', 'setup.q4', 'setup.q5', 'setup.q6'] as const) {
      await expect(page.getByRole('heading', { name: t(q) })).toBeVisible();
      await sendFreeText(page, 'نعم كما هو');
    }

    const preview = (await (await previewResponsePromise).json()) as PreviewBody;

    await expect(page.getByTestId('setup-diff-card')).toBeVisible();
    for (const line of [...preview.summary.npi, ...preview.summary.already]) {
      await expect(page.getByTestId('setup-diff-card').getByText(line, { exact: false }).first()).toBeVisible();
    }
    await expect(
      page.getByText(
        t('setup.diff.counts', {
          create: formatNumber(preview.plan.counts.create),
          update: formatNumber(preview.plan.counts.update),
          skip: formatNumber(preview.plan.counts.skip),
          blocked: formatNumber(preview.plan.counts.blocked),
        }),
      ),
    ).toBeVisible();

    const hasRemoval = preview.plan.steps.some((s) => s.kind === 'role' && (s.permissionsRemoved?.length ?? 0) > 0);
    if (hasRemoval) {
      await expect(page.getByTestId('setup-diff-card').getByText(t('setup.diff.removed')).first()).toBeVisible();
    }
  });

  test('an unclear free-text answer shows the loading indicator then the unclear notice', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/setup');
    await waitForHydration(page);

    await page.route(SETUP_PATH, async (route) => {
      const body = await postedBody(route);
      if (body.action === 'answer' && 'text' in body) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return jsonRoute(route, 200, { unclear: t('setup.unclear') });
      }
      return route.continue();
    });

    await sendFreeText(page, 'كلام غير مفهوم تماما');

    await expect(page.getByRole('status').getByText(t('setup.loading'))).toBeVisible();
    await expect(page.getByText(t('setup.unclear'))).toBeVisible();
    // Still on step 1 — the unclear reply never advances the wizard.
    await expect(page.getByRole('heading', { name: t('setup.q1') })).toBeVisible();
  });

  test('apply mocked as a full success shows setup.apply.done and the per-step outcomes', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/setup');
    await waitForHydration(page);

    await sendFreeText(page, 'إحنا مقاول EPC');
    await page.getByRole('button', { name: t('setup.save_step') }).click();
    const previewResponsePromise = waitForPreviewResponse(page);
    for (const _q of ['q3', 'q4', 'q5', 'q6']) {
      await sendFreeText(page, 'نعم كما هو');
    }

    const preview = (await (await previewResponsePromise).json()) as PreviewBody;

    await page.route(SETUP_PATH, async (route) => {
      const body = await postedBody(route);
      if (body.action !== 'apply') return route.continue();
      const steps = preview.plan.steps.map((s) => ({
        stepId: s.id,
        kind: s.kind,
        outcome: s.action === 'create' ? 'created' : s.action === 'update' ? 'updated' : s.action === 'skip' ? 'skipped' : 'blocked',
        npiId: s.action === 'blocked' ? null : 'mock-id',
        reasonAr: s.action === 'blocked' ? 'محجوب' : null,
        npiMessage: null,
      }));
      return jsonRoute(route, 200, {
        result: {
          steps,
          gaps: [],
          counts: { created: 0, updated: 0, skipped: 0, blocked: 0, failed: 0 },
          departmentIdByCode: {},
          roleIdByKey: {},
          completed: true,
        },
        summary: preview.summary,
        persisted: { positionsWritten: 5, positionsSkipped: [], assignmentsWritten: 1, holdersSkipped: [] },
      });
    });

    await expect(page.getByTestId('setup-diff-card')).toBeVisible();
    await page.getByRole('button', { name: t('preview.approve') }).click();

    await expect(page.getByText(t('setup.apply.done'))).toBeVisible();
    await expect(page.getByTestId('setup-apply-step').first()).toBeVisible();
    await expect(page.getByText(t('setup.assignments_written', { n: formatNumber(1) }))).toBeVisible();
    await expect(page.getByTestId('setup-diff-card').getByRole('link', { name: t('nav.home') })).toBeVisible();
  });

  test('apply mocked as a partial failure shows the error alert with the failed reason', async ({ page }) => {
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/setup');
    await waitForHydration(page);

    await sendFreeText(page, 'إحنا مقاول EPC');
    await page.getByRole('button', { name: t('setup.save_step') }).click();
    const previewResponsePromise = waitForPreviewResponse(page);
    for (const _q of ['q3', 'q4', 'q5', 'q6']) {
      await sendFreeText(page, 'نعم كما هو');
    }

    const preview = (await (await previewResponsePromise).json()) as PreviewBody;
    // The very first step of the plan is made to fail, regardless of its
    // original action — this is mocked data (apply is never live in this
    // test), and it guarantees exactly one failure exists even if the org's
    // current NPI state happens to leave the plan with no `create` step.
    const failingStepId = preview.plan.steps[0].id;
    const failReason = 'رفض NPI إنشاء هذا العنصر';
    const npiMessage = 'Validation failed: duplicate code';

    await page.route(SETUP_PATH, async (route) => {
      const body = await postedBody(route);
      if (body.action !== 'apply') return route.continue();
      const steps = preview.plan.steps.map((s) => {
        if (s.id === failingStepId) {
          return { stepId: s.id, kind: s.kind, outcome: 'failed', npiId: null, reasonAr: failReason, npiMessage };
        }
        const outcome = s.action === 'create' ? 'created' : s.action === 'update' ? 'updated' : s.action === 'skip' ? 'skipped' : 'blocked';
        return { stepId: s.id, kind: s.kind, outcome, npiId: outcome === 'blocked' ? null : 'mock-id', reasonAr: outcome === 'blocked' ? 'محجوب' : null, npiMessage: null };
      });
      return jsonRoute(route, 200, {
        result: {
          steps,
          gaps: [],
          counts: { created: 0, updated: 0, skipped: 0, blocked: 0, failed: 1 },
          departmentIdByCode: {},
          roleIdByKey: {},
          completed: false,
        },
        summary: preview.summary,
        persisted: { positionsWritten: 0, positionsSkipped: [], assignmentsWritten: 0, holdersSkipped: [] },
      });
    });

    await page.getByRole('button', { name: t('preview.approve') }).click();

    await expect(page.getByRole('alert').getByText(t('setup.error.apply', { reason: failReason }))).toBeVisible();
    await expect(page.getByTestId('setup-apply-step').filter({ hasText: npiMessage })).toBeVisible();
  });

  test('no horizontal scroll at 390px on steps 1, 2 and 7', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = readAdminCredentials();
    await signIn(page, admin);
    await page.goto('/copilot/setup');
    await waitForHydration(page);

    async function assertNoScroll() {
      const hasHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalScroll).toBe(false);
    }

    await expect(page.getByRole('heading', { name: t('setup.q1') })).toBeVisible();
    await assertNoScroll();

    await sendFreeText(page, 'إحنا مقاول EPC');
    await expect(page.getByRole('heading', { name: t('setup.q2') })).toBeVisible();
    await assertNoScroll();

    await page.getByRole('button', { name: t('setup.save_step') }).click();
    for (const _q of ['q3', 'q4', 'q5', 'q6']) {
      await sendFreeText(page, 'نعم كما هو');
    }
    await expect(page.getByTestId('setup-diff-card')).toBeVisible();
    await assertNoScroll();
  });
});
