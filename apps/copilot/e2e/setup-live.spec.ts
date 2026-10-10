// Live T-20 eval (spec/madar/05 row T-20, 06 AT-11, 07 §G-M2-1..4,
// 09 §«المرحلة ٢»): applies each of the six setup profiles against its own
// scratch NPI organization (`packages/db/prisma/madar-scratch-orgs.ts`),
// confirms NPI actually ends up holding the plan, that a second apply is a
// no-op (idempotent), and that the session finished inside the 30-minute
// target (assumption a6, `src/metrics/onboarding.ts`). Gated behind
// `COPILOT_LIVE=1` (see `package.json`'s `e2e:live-setup`) so a normal
// `npx playwright test` run never executes it — `playwright.config.ts`'s
// `grepInvert` excludes anything tagged `@live` by default.
//
// `signIn`/`sendFreeText`/`waitForPreviewResponse` are copied from
// `e2e/setup.spec.ts` rather than imported: that file does not export them
// and T-20 must not modify it (closed file list).
//
// 08 §E.9: nothing here is recorded as passed without actually running it —
// every assertion below reads a real response from a real local NPI API and
// a real copilot dev server (`playwright.config.ts`'s `webServer`).
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page, Response } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { t, type ArKey } from '../src/i18n/ar';
import { computeOnboardingMetric, sessionMinutes, type OnboardingSessionLike } from '../src/metrics/onboarding';
import { disconnectSetupDb, resetOpenSetupSessions } from './fixtures/setup-db';
import {
  disconnectScratchDb,
  npiLogin,
  readFirmConfig,
  readNpiState,
  readOnboardingSessions,
  scratchAccount,
  writeEvalRun,
  type NpiState,
  type ScratchAccount,
} from './fixtures/scratch-orgs';

// ─── Samples ────────────────────────────────────────────────────────────────

interface SampleExpect {
  hiddenModules: string[];
  docTypeKeys: string[];
  gapsContain: string[];
  terminologyContains: Record<string, string> | null;
}

interface Sample {
  id: string;
  profileKey: string;
  scratchOrgKey: string;
  q1: string;
  q1ExpectedSource: 'deterministic' | 'model';
  q3: string;
  q4: string;
  q5: string;
  q6: string;
  q6ExpectedSource: 'deterministic' | 'model';
  expect: SampleExpect;
}

interface SamplesFile {
  version: number;
  targetMinutes: number;
  samples: Sample[];
}

const SAMPLES_PATH = path.resolve(__dirname, '..', 'eval', 'setup-samples.json');

function loadSamples(): SamplesFile {
  return JSON.parse(readFileSync(SAMPLES_PATH, 'utf8')) as SamplesFile;
}

const samplesFile = loadSamples();

// ─── Copied from e2e/setup.spec.ts (not exported there) ────────────────────

async function signIn(page: Page, account: ScratchAccount): Promise<void> {
  await page.goto('/copilot/login');
  await page.getByLabel(t('login.email')).fill(account.email);
  await page.getByLabel(t('login.password')).fill(account.password);
  await page.getByRole('button', { name: t('login.submit') }).click();
  await page.waitForURL('**/copilot');
}

async function sendFreeText(page: Page, text: string): Promise<void> {
  const textarea = page.getByLabel(t('setup.free_text'));
  await expect(textarea).toBeEditable();
  await textarea.fill(text);
  await expect(textarea).toHaveValue(text);
  await page.getByRole('button', { name: t('chat.send') }).click();
}

function postActionBody(res: Response): Record<string, unknown> | null {
  try {
    return res.request().postDataJSON() as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

function waitForSetupAction(page: Page, matches: (body: Record<string, unknown>) => boolean) {
  return page.waitForResponse((res) => {
    if (res.request().method() !== 'POST' || !res.url().includes('/copilot/api/setup')) return false;
    const body = postActionBody(res);
    return body !== null && matches(body);
  });
}

function waitForAnswerResponse(page: Page, step: number) {
  return waitForSetupAction(page, (body) => body.action === 'answer' && body.step === step);
}

/** Same discipline as `setup.spec.ts`'s own `waitForPreviewResponse`: set up
 *  *before* the action that triggers it, never awaited right after the
 *  triggering click. */
function waitForPreviewResponse(page: Page) {
  return waitForSetupAction(page, (body) => body.action === 'preview');
}

function waitForApplyResponse(page: Page) {
  return waitForSetupAction(page, (body) => body.action === 'apply');
}

// ─── Response shapes (mirroring src/onboarding/service.ts) ──────────────────

interface BlockedReasonLike {
  code: string;
  [key: string]: unknown;
}

interface PlanStepLike {
  id: string;
  kind: 'department' | 'role' | 'approval_rule' | 'item';
  action: 'create' | 'update' | 'skip' | 'blocked';
  blocked: BlockedReasonLike | null;
  existingId: string | null;
  code?: string;
  roleKey?: string;
  permissions?: string[];
  docType?: string;
  minAmount?: number;
  maxAmount?: number | null;
  stepRoleKeys?: string[];
  sku?: string;
}

interface SummaryAr {
  npi: string[];
  already: string[];
  copilot: string[];
  blocked: string[];
  gaps: string[];
}

interface PreviewBody {
  plan: { steps: PlanStepLike[]; counts: { create: number; update: number; skip: number; blocked: number } };
  summary: SummaryAr;
}

interface AnswerBody {
  parsed: { step: number; profileKey?: string };
  source: 'deterministic' | 'model' | 'structured';
}

interface UnclearBody {
  unclear: string;
}

/** `answer` can come back as either shape (`src/onboarding/service.ts`'s
 *  `SetupAnswerResult | SetupUnclearResult`). Asserting on `.unclear` first,
 *  with the sentence and the reason in the failure message, gives a real
 *  model-path failure (an invalid-enum `profileKey`/`terminology` key the
 *  model invented, for instance) a readable assertion instead of a bare
 *  `TypeError` reading `.parsed` off `undefined` — the underlying "the
 *  sentence did not resolve as expected" finding is unchanged either way; 08
 *  §E.9 forbids papering over it, not writing a clearer error message. */
function expectAnswer(body: AnswerBody | UnclearBody, context: string): AnswerBody {
  if ('unclear' in body) {
    throw new Error(`${context}: setup answered "unclear" — ${body.unclear}`);
  }
  return body;
}

interface ApplyBody {
  result: {
    steps: { stepId: string; kind: string; outcome: string; npiId: string | null; reasonAr: string | null; npiMessage: string | null }[];
    counts: Record<string, number>;
    completed: boolean;
  };
  summary: SummaryAr;
  persisted: { positionsWritten: number; positionsSkipped: unknown[]; assignmentsWritten: number; holdersSkipped: unknown[] };
}

// ─── NPI-state lookups for the post-apply check ─────────────────────────────

function departmentPresent(state: NpiState, code: string): boolean {
  return state.departments.some((d) => d.code === code);
}

function rolePresentWithPermissions(state: NpiState, roleKey: string, permissions: string[]): boolean {
  const role = state.roles.find((r) => r.key === roleKey);
  if (!role) return false;
  const a = new Set(role.permissions);
  const b = new Set(permissions);
  return a.size === b.size && [...a].every((p) => b.has(p));
}

function rulePresent(state: NpiState, docType: string, minAmount: number, maxAmount: number | null, stepRoleKeys: string[]): boolean {
  const rule = state.rules.find(
    (r) => r.documentType === docType && r.minAmount === minAmount && r.maxAmount === maxAmount && r.isActive,
  );
  if (!rule) return false;
  return rule.stepRoleKeys.length === stepRoleKeys.length && rule.stepRoleKeys.every((k, i) => k === stepRoleKeys[i]);
}

function itemPresent(state: NpiState, sku: string): boolean {
  return state.items.some((i) => i.sku === sku);
}

function stepPresentInState(state: NpiState, step: PlanStepLike): boolean {
  switch (step.kind) {
    case 'department':
      return departmentPresent(state, step.code!);
    case 'role':
      return rolePresentWithPermissions(state, step.roleKey!, step.permissions ?? []);
    case 'approval_rule':
      return rulePresent(state, step.docType!, step.minAmount!, step.maxAmount ?? null, step.stepRoleKeys ?? []);
    case 'item':
      return itemPresent(state, step.sku!);
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

interface ReportEntry {
  id: string;
  profileKey: string;
  q1Source: string;
  q6Source: string;
  counts: { planned: PreviewBody['plan']['counts']; applied: Record<string, number> };
  blocked: string[];
  gaps: string[];
  persisted: ApplyBody['persisted'];
  minutes: number | null;
  rerunCounts: { create: number; update: number };
}

const report: ReportEntry[] = [];

test.describe('setup live apply (T-20) @live-setup', () => {
  test.skip(!process.env.COPILOT_LIVE, 'live run — use npm run e2e:live-setup');
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test.beforeAll(async ({ request }) => {
    for (const sample of samplesFile.samples) {
      const admin = scratchAccount(sample.scratchOrgKey, 'admin');
      try {
        await npiLogin(request, admin);
      } catch (err) {
        throw new Error(
          `scratch organizations missing — run: npm run db:seed:madar-scratch (login failed for ${admin.email}: ${
            (err as Error).message
          })`,
        );
      }
    }
  });

  test.afterAll(async () => {
    const finishedAt = new Date();
    const timestamp = finishedAt.toISOString().replace(/:/g, '-');
    const outDir = path.resolve(__dirname, '..', 'test-results', 'setup-live');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, `report-${timestamp}.json`), JSON.stringify(report, null, 2), 'utf8');

    const passed = report.length === samplesFile.samples.length;
    await writeEvalRun({
      kind: 'setup_live',
      startedAt: new Date(finishedAt.getTime() - report.length * 60_000),
      finishedAt,
      score: report.length / samplesFile.samples.length,
      passed,
      detailsJson: report,
    });

    await disconnectSetupDb();
    await disconnectScratchDb();
  });

  for (const sample of samplesFile.samples) {
    test(`@live-setup ${sample.profileKey}: setup applied in NPI, idempotent, within 30 minutes`, async ({ page, request }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'desktop only — live apply need run once, not per viewport');

      const admin = scratchAccount(sample.scratchOrgKey, 'admin');
      const session = await npiLogin(request, admin);
      await resetOpenSetupSessions(session.orgId);
      const before = await readNpiState(request, session.token);

      await signIn(page, admin);
      await page.goto('/copilot/setup');

      // ── Q1 ──────────────────────────────────────────────────────────────
      const q1Promise = waitForAnswerResponse(page, 1);
      await sendFreeText(page, sample.q1);
      const q1Body = expectAnswer((await (await q1Promise).json()) as AnswerBody | UnclearBody, `${sample.id} q1 "${sample.q1}"`);
      expect(q1Body.parsed.step).toBe(1);
      expect(q1Body.parsed.profileKey).toBe(sample.profileKey);
      expect(q1Body.source).toBe(sample.q1ExpectedSource);
      await expect(page.getByRole('heading', { name: t('setup.q2') })).toBeVisible();

      // ── Q2 ──────────────────────────────────────────────────────────────
      // `.first()`: the admin position's title is also «مدير النظام», so the
      // accessible-name match is not unique on the scratch orgs (first live
      // run wrote 0 assignments because the strict-mode locator threw).
      const holderCheckbox = page.getByRole('checkbox', { name: admin.nameAr }).first();
      if (await holderCheckbox.isVisible().catch(() => false)) {
        await holderCheckbox.check();
      }
      await page.getByRole('button', { name: t('setup.save_step') }).click();
      await expect(page.getByRole('heading', { name: t('setup.q3') })).toBeVisible();

      // ── Q3–Q6 ───────────────────────────────────────────────────────────
      let q6Source: AnswerBody['source'] = 'deterministic';
      let previewBody: PreviewBody | undefined;
      const stepTexts: Record<3 | 4 | 5 | 6, string> = { 3: sample.q3, 4: sample.q4, 5: sample.q5, 6: sample.q6 };
      for (const step of [3, 4, 5, 6] as const) {
        await expect(page.getByRole('heading', { name: t(`setup.q${step}` as ArKey) })).toBeVisible();
        const answerPromise = waitForAnswerResponse(page, step);
        const previewPromise = step === 6 ? waitForPreviewResponse(page) : null;
        await sendFreeText(page, stepTexts[step]);
        const answerBody = expectAnswer(
          (await (await answerPromise).json()) as AnswerBody | UnclearBody,
          `${sample.id} q${step} "${stepTexts[step]}"`,
        );
        if (step === 6) {
          q6Source = answerBody.source;
          expect(answerBody.source).toBe(sample.q6ExpectedSource);
          previewBody = (await (await previewPromise!).json()) as PreviewBody;
        }
      }
      if (!previewBody) throw new Error('preview response was never captured');

      expect(previewBody.summary.gaps.some((g) => g.includes('تعريفات التدفقات'))).toBe(true);
      for (const step of previewBody.plan.steps) {
        if (step.action === 'blocked') {
          expect(['role_without_active_user', 'band_overlap']).toContain(step.blocked?.code);
        }
      }
      await expect(page.getByTestId('setup-diff-card')).toBeVisible();

      // ── Apply ───────────────────────────────────────────────────────────
      const applyPromise = waitForApplyResponse(page);
      await page.getByRole('button', { name: t('preview.approve') }).click();
      const applyBody = (await (await applyPromise).json()) as ApplyBody;
      expect(applyBody.result.completed).toBe(true);
      expect(applyBody.result.counts.failed).toBe(0);
      await expect(page.getByText(t('setup.apply.done'))).toBeVisible();
      await expect(page.getByTestId('setup-apply-step')).toHaveCount(applyBody.result.steps.length);

      // ── NPI state after apply ────────────────────────────────────────────
      const after = await readNpiState(request, session.token);
      for (const step of previewBody.plan.steps) {
        if (step.action === 'create' || step.action === 'update' || step.action === 'skip') {
          expect(stepPresentInState(after, step), `step ${step.id} (${step.action}) should be present in NPI after apply`).toBe(true);
        } else if (step.action === 'blocked' && step.existingId === null) {
          expect(stepPresentInState(before, step) || stepPresentInState(after, step), `blocked step ${step.id} must not be newly created`).toBe(
            stepPresentInState(before, step),
          );
        }
      }

      // ── Copilot DB ────────────────────────────────────────────────────────
      const firmConfig = await readFirmConfig(session.orgId);
      expect(firmConfig).not.toBeNull();
      expect(firmConfig!.profileKey).toBe(sample.profileKey);
      const visibleModules = firmConfig!.visibleModulesJson as string[];
      for (const hidden of sample.expect.hiddenModules) expect(visibleModules).not.toContain(hidden);
      expect(visibleModules).toContain('finance');
      const docTypeKeys = (firmConfig!.acceptedDocTypesJson as { key: string }[]).map((d) => d.key).sort();
      expect(docTypeKeys).toEqual([...sample.expect.docTypeKeys].sort());
      const gaps = (firmConfig!.npiApiGapsJson as { gaps: { kind: string }[] }).gaps;
      expect(gaps.some((g) => g.kind === 'workflow_definitions')).toBe(true);
      if (sample.expect.terminologyContains) {
        const terminology = firmConfig!.terminologyJson as Record<string, string>;
        for (const [key, substring] of Object.entries(sample.expect.terminologyContains)) {
          expect(terminology[key]).toBeDefined();
          expect(terminology[key]).toContain(substring);
        }
      }

      const sessions = await readOnboardingSessions(session.orgId);
      const completedSessions = sessions.filter((s) => s.completedAt !== null);
      expect(completedSessions.length).toBeGreaterThan(0);
      const metric = computeOnboardingMetric(sessions as OnboardingSessionLike[]);
      expect(metric.verdict).not.toBe('no_data');
      const latest = completedSessions[completedSessions.length - 1];
      const latestMinutes = sessionMinutes(latest as OnboardingSessionLike);
      expect(latestMinutes).not.toBeNull();
      expect(latestMinutes!).toBeLessThanOrEqual(30);
      expect(metric.medianMinutes).not.toBeNull();
      expect(metric.medianMinutes!).toBeLessThanOrEqual(30);

      // ── Idempotency through T-19 (rerun the terminology step) ───────────
      await page.goto('/copilot/settings');
      await page.getByTestId('settings-terminology-card').getByRole('button', { name: t('settings.rerun') }).click();
      await page.waitForURL('**/copilot/setup');
      await expect(page.getByRole('heading', { name: t('setup.q6') })).toBeVisible();

      const rerunPreviewPromise = waitForPreviewResponse(page);
      await sendFreeText(page, 'نعم كما هو');
      const rerunPreview = (await (await rerunPreviewPromise).json()) as PreviewBody;
      expect(rerunPreview.plan.counts.create).toBe(0);
      expect(rerunPreview.plan.counts.update).toBe(0);

      report.push({
        id: sample.id,
        profileKey: sample.profileKey,
        q1Source: q1Body.source,
        q6Source,
        counts: { planned: previewBody.plan.counts, applied: applyBody.result.counts },
        blocked: previewBody.plan.steps.filter((s) => s.action === 'blocked').map((s) => s.blocked?.code ?? 'unknown'),
        gaps: previewBody.summary.gaps,
        persisted: applyBody.persisted,
        minutes: latestMinutes,
        rerunCounts: { create: rerunPreview.plan.counts.create, update: rerunPreview.plan.counts.update },
      });
    });
  }
});
