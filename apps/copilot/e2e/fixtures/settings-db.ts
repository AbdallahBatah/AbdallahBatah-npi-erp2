// Database fixture for e2e/settings.spec.ts (T-19): seeds a completed epc
// setup (one `firm_config` row plus one completed `onboarding_sessions` row)
// so the settings screen has something to show, and restores the org's prior
// state afterwards — same snapshot/restore shape as `setup-db.ts`'s
// `resetOpenSetupSessions`, but for the rows T-19 reads instead of deletes.
//
// Uses the copilot's own Prisma client (never NPI's database, 08 §E.10) and
// the same `.env` loading `tests/helpers/load-env.ts` already does for Jest.
// Never logs the connection URL.
import '../../tests/helpers/load-env';
import { PrismaClient, type FirmConfig, type ManualBaseline } from '../../src/generated/prisma';
import { loadProfilePack } from '../../src/onboarding/catalog';

let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

export interface SettingsFixtureHandle {
  npiOrgId: string;
  sessionId: string;
  priorFirmConfig: FirmConfig | null;
  priorBaselines: ManualBaseline[];
}

/**
 * Seeds the org with a completed epc configuration: a `firm_config` row built
 * from the epc catalog pack (the same pack `setup.spec.ts` drives the wizard
 * through), one blocked leftover (`approval_rule:PURCHASE_ORDER:100000`, the
 * band T-18/T-20's own fixtures also exercise), and a matching completed
 * `onboarding_sessions` row so a `rerun` has real answers to resume from.
 * Snapshots whatever the org held before, for `restoreSettingsFixture` to put
 * back; deletes the org's existing `manual_baselines` rows outright (T-19
 * owns writing them directly, so there is nothing of value to preserve for a
 * test run beyond "put none back").
 */
export async function seedSettingsFixture(npiOrgId: string): Promise<SettingsFixtureHandle> {
  const db = getClient();
  const pack = loadProfilePack('epc');
  const now = new Date();

  const priorFirmConfig = await db.firmConfig.findUnique({ where: { npiOrgId } });
  const priorBaselines = await db.manualBaseline.findMany({ where: { npiOrgId } });

  await db.firmConfig.upsert({
    where: { npiOrgId },
    create: {
      npiOrgId,
      profileKey: 'epc',
      visibleModulesJson: pack.visibleModules,
      acceptedDocTypesJson: pack.acceptedDocTypes,
      terminologyJson: pack.terminology,
      npiApiGapsJson: {
        gaps: [],
        blocked: [{ stepId: 'approval_rule:PURCHASE_ORDER:100000', reasonAr: 'تعارض مع نطاق قائم' }],
        failed: [],
        appliedAt: now.toISOString(),
      },
      setupCompletedAt: now,
    },
    update: {
      profileKey: 'epc',
      visibleModulesJson: pack.visibleModules,
      acceptedDocTypesJson: pack.acceptedDocTypes,
      terminologyJson: pack.terminology,
      npiApiGapsJson: {
        gaps: [],
        blocked: [{ stepId: 'approval_rule:PURCHASE_ORDER:100000', reasonAr: 'تعارض مع نطاق قائم' }],
        failed: [],
        appliedAt: now.toISOString(),
      },
      setupCompletedAt: now,
    },
  });

  await db.manualBaseline.deleteMany({ where: { npiOrgId } });

  const session = await db.onboardingSession.create({
    data: {
      npiOrgId,
      // Attribution only (no FK); the admin who "ran" this seeded session.
      npiUserId: 'e2e-settings-fixture',
      completedAt: now,
      profileChosen: 'epc',
      stepsJson: {
        step: 7,
        answers: {
          profileKey: 'epc',
          acceptedDocTypeKeys: pack.acceptedDocTypes.map((d) => d.key),
          terminology: pack.terminology,
        },
        completedSteps: [1, 2, 3, 4, 5, 6],
      },
    },
  });

  return { npiOrgId, sessionId: session.id, priorFirmConfig, priorBaselines };
}

/** Deletes `firm_config`'s row for `npiOrgId` — the one case `settings.spec.
 *  ts`'s "no config" test needs on top of the normal seed, restored by
 *  `restoreSettingsFixture` from the handle's snapshot like everything else. */
export async function deleteFirmConfig(npiOrgId: string): Promise<void> {
  await getClient().firmConfig.deleteMany({ where: { npiOrgId } });
}

/**
 * Undoes `seedSettingsFixture`: removes the session it created and any open
 * session the org picked up meanwhile (a `rerun` test resumes the seeded one,
 * which is `completedAt`-set and so untouched by `resetOpenSetupSessions`;
 * resuming it through `/setup` does open a fresh one), deletes the org's
 * `manual_baselines` rows, and restores the snapshotted `firm_config` (or
 * deletes the row if there was none before) and baselines.
 */
export async function restoreSettingsFixture(handle: SettingsFixtureHandle): Promise<void> {
  const db = getClient();
  const { npiOrgId, sessionId, priorFirmConfig, priorBaselines } = handle;

  await db.onboardingSession.deleteMany({ where: { id: sessionId } });
  await db.onboardingSession.deleteMany({ where: { npiOrgId, completedAt: null, id: { not: sessionId } } });

  await db.manualBaseline.deleteMany({ where: { npiOrgId } });
  for (const baseline of priorBaselines) {
    await db.manualBaseline.create({
      data: {
        npiOrgId: baseline.npiOrgId,
        flowType: baseline.flowType,
        minutes: baseline.minutes,
        measuredAt: baseline.measuredAt,
        npiUserId: baseline.npiUserId,
      },
    });
  }

  if (priorFirmConfig) {
    await db.firmConfig.upsert({
      where: { npiOrgId },
      create: {
        npiOrgId,
        profileKey: priorFirmConfig.profileKey,
        visibleModulesJson: priorFirmConfig.visibleModulesJson as object,
        acceptedDocTypesJson: priorFirmConfig.acceptedDocTypesJson as object,
        terminologyJson: priorFirmConfig.terminologyJson as object,
        npiApiGapsJson: priorFirmConfig.npiApiGapsJson as object,
        setupCompletedAt: priorFirmConfig.setupCompletedAt,
      },
      update: {
        profileKey: priorFirmConfig.profileKey,
        visibleModulesJson: priorFirmConfig.visibleModulesJson as object,
        acceptedDocTypesJson: priorFirmConfig.acceptedDocTypesJson as object,
        terminologyJson: priorFirmConfig.terminologyJson as object,
        npiApiGapsJson: priorFirmConfig.npiApiGapsJson as object,
        setupCompletedAt: priorFirmConfig.setupCompletedAt,
      },
    });
  } else {
    await db.firmConfig.deleteMany({ where: { npiOrgId } });
  }
}

/** Closes the fixture's own Prisma connection — call once, from `afterAll`. */
export async function disconnectSettingsDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
