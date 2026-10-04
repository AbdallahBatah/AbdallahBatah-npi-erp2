// Executes an onboarding plan against NPI's admin API and records the result
// in the copilot's own database (F-14, spec/madar/02 §7). Three entry points:
//
//  - `loadNpiSnapshot` + `dryRun` — read what NPI holds, build the plan, show
//    it. Nothing is written. This is the «هذا ما سأضبطه في NPI» card.
//  - `applyPlan` — run the plan's steps in order, one NPI call per write
//    step, as the logged-in administrator with their own JWT
//    (`src/npi/client.ts`; 08 §E.10). A step NPI refuses is recorded with
//    NPI's own message and the run goes on to the next independent step;
//    re-running the same plan afterwards is a no-op for everything that
//    succeeded (the plan builder marks it `skip`).
//  - `persistCopilotConfig` — write `firm_config` and the copilot `positions`
//    rows from the plan and the apply result.
//
// Gaps and blocked steps are reported, never worked around. No step here
// ever deletes anything, decides an approval, or touches a user account.
import type { NpiClient } from '../npi/client';
import { readApprovalRules, readDirectoryUsers, readItems, readRoles } from '../npi/admin';
import { readDepartments } from '../npi/directory';
import { NpiError } from '../npi/errors';
import { readPermissionCatalog } from '../npi/permissions';
import { readEntityRef } from '../npi/responses';
import { describeBlockedAr, SNAPSHOT_READ_PERMISSION, type BlockedReason, type NpiApiGap } from './gaps';
import type { ProfilePack } from './profile.schema';
import {
  buildPlan,
  type ApprovalRuleStep,
  type NpiSnapshot,
  type OnboardingPlan,
  type PlanCaller,
  type PlanStep,
  type SetupAnswers,
} from './plan';

/** The slice of `NpiClient` the onboarding uses — nothing else. */
export type OnboardingNpi = Pick<
  NpiClient,
  | 'listPermissions'
  | 'listRoles'
  | 'listDepartments'
  | 'listDepartmentDirectory'
  | 'listApprovalRules'
  | 'listItems'
  | 'createDepartment'
  | 'createRole'
  | 'updateRole'
  | 'createApprovalRule'
  | 'updateApprovalRule'
  | 'createItem'
>;

// ─── Snapshot ───────────────────────────────────────────────────────────────

/**
 * Reads each admin slot only when the caller holds its guard permission
 * (`SNAPSHOT_READ_PERMISSION`), and turns a 403 from NPI into `null` as well
 * (NPI is the authority on what this user may see). Any other `NpiError` —
 * network, timeout, 5xx, a malformed body — is rethrown: a plan built on a
 * half-read NPI would be a guess.
 */
export async function loadNpiSnapshot(npi: OnboardingNpi, caller: PlanCaller): Promise<NpiSnapshot> {
  const has = (permission: string) => caller.permissions.includes(permission);

  async function slot<T>(permission: string, read: () => Promise<T>): Promise<T | null> {
    if (!has(permission)) return null;
    try {
      return await read();
    } catch (err) {
      if (err instanceof NpiError && err.kind === 'forbidden') return null;
      throw err;
    }
  }

  return {
    permissions: await slot(SNAPSHOT_READ_PERMISSION.permissions, async () => readPermissionCatalog(await npi.listPermissions())),
    roles: await slot(SNAPSHOT_READ_PERMISSION.roles, async () => readRoles(await npi.listRoles())),
    departments: await slot(SNAPSHOT_READ_PERMISSION.departments, async () => readDepartments(await npi.listDepartments())),
    users: await slot(SNAPSHOT_READ_PERMISSION.directory, async () => readDirectoryUsers(await npi.listDepartmentDirectory())),
    approvalRules: await slot(SNAPSHOT_READ_PERMISSION.rules, async () => readApprovalRules(await npi.listApprovalRules())),
    items: await slot(SNAPSHOT_READ_PERMISSION.items, async () => readItems(await npi.listItems())),
  };
}

/** Read NPI, build the plan. Writes nothing. */
export async function dryRun(
  deps: { npi: OnboardingNpi },
  pack: ProfilePack,
  answers: SetupAnswers,
  caller: PlanCaller,
): Promise<OnboardingPlan> {
  const snapshot = await loadNpiSnapshot(deps.npi, caller);
  return buildPlan(pack, answers, snapshot, caller);
}

// ─── Apply ──────────────────────────────────────────────────────────────────

export type StepOutcome = 'created' | 'updated' | 'skipped' | 'blocked' | 'failed';

export interface StepResult {
  stepId: string;
  kind: PlanStep['kind'];
  outcome: StepOutcome;
  /** NPI's id of the object (created, updated or already present). */
  npiId: string | null;
  /** Arabic reason for `blocked`/`failed` (the UI's text). */
  reasonAr: string | null;
  /** NPI's own message for `failed`, verbatim, never translated. */
  npiMessage: string | null;
}

export interface ApplyResult {
  steps: StepResult[];
  gaps: NpiApiGap[];
  counts: Record<StepOutcome, number>;
  /** Every department / role NPI holds after the run, by code / key —
   *  existing ones from the plan plus the ones created here. */
  departmentIdByCode: Record<string, string>;
  roleIdByKey: Record<string, string>;
  /** True when no step failed. Blocked steps and gaps do not clear this flag
   *  false: they are acknowledged states the administrator can act on. */
  completed: boolean;
}

function idOf(body: unknown): string {
  return readEntityRef(body).id;
}

/**
 * Runs `plan.steps` in order. Dependencies between steps are resolved at
 * execution time from `departmentIdByCode` / `roleIdByKey`, which start from
 * the ids the snapshot already knew and grow with each successful create —
 * so an approval rule whose role was created three steps earlier gets the
 * fresh id, and one whose role failed to be created is `blocked`, not sent.
 */
export async function applyPlan(deps: { npi: OnboardingNpi }, plan: OnboardingPlan): Promise<ApplyResult> {
  const { npi } = deps;
  const results: StepResult[] = [];
  const departmentIdByCode: Record<string, string> = {};
  const roleIdByKey: Record<string, string> = {};
  let sessionLost: NpiError | null = null;

  for (const step of plan.steps) {
    if (step.kind === 'department' && step.existingId) departmentIdByCode[step.code] = step.existingId;
    if (step.kind === 'role' && step.existingId) roleIdByKey[step.roleKey] = step.existingId;
  }

  const record = (step: PlanStep, outcome: StepOutcome, npiId: string | null, reasonAr: string | null = null, npiMessage: string | null = null) => {
    results.push({ stepId: step.id, kind: step.kind, outcome, npiId, reasonAr, npiMessage });
  };
  const blocked = (step: PlanStep, reason: BlockedReason) =>
    record(step, 'blocked', null, describeBlockedAr(reason, plan.permissionLabel));

  for (const step of plan.steps) {
    if (step.action === 'blocked') {
      blocked(step, step.blocked!);
      continue;
    }
    if (step.action === 'skip') {
      record(step, 'skipped', step.existingId);
      continue;
    }
    if (sessionLost) {
      record(step, 'failed', null, sessionLost.messageAr, sessionLost.npiMessage);
      continue;
    }

    try {
      switch (step.kind) {
        case 'department': {
          const id = idOf(await npi.createDepartment({ code: step.code, nameAr: step.nameAr, nameEn: step.nameEn }));
          departmentIdByCode[step.code] = id;
          record(step, 'created', id);
          break;
        }
        case 'role': {
          if (step.action === 'update') {
            const id = idOf(await npi.updateRole(step.existingId!, { permissions: step.permissions }));
            roleIdByKey[step.roleKey] = id;
            record(step, 'updated', id);
          } else {
            const id = idOf(
              await npi.createRole({ key: step.roleKey, nameAr: step.nameAr, nameEn: step.nameEn, permissions: step.permissions }),
            );
            roleIdByKey[step.roleKey] = id;
            record(step, 'created', id);
          }
          break;
        }
        case 'approval_rule': {
          const missingRole = step.stepRoleKeys.find((key) => roleIdByKey[key] === undefined);
          if (missingRole !== undefined) {
            blocked(step, { code: 'depends_on_blocked_role', roleKey: missingRole });
            break;
          }
          const steps = step.stepRoleKeys.map((key) => ({ roleId: roleIdByKey[key] }));
          if (step.action === 'update') {
            const id = idOf(await npi.updateApprovalRule(step.existingId!, ruleUpdateDto(step, steps)));
            record(step, 'updated', id);
          } else {
            const id = idOf(
              await npi.createApprovalRule({
                documentType: step.docType,
                minAmount: step.minAmount,
                maxAmount: step.maxAmount,
                steps,
              }),
            );
            record(step, 'created', id);
          }
          break;
        }
        case 'item': {
          const id = idOf(
            await npi.createItem({
              sku: step.sku,
              nameAr: step.nameAr,
              nameEn: step.nameEn,
              itemCategory: step.itemCategory,
              uom: step.uom,
              isSerialised: step.isSerialised,
            }),
          );
          record(step, 'created', id);
          break;
        }
      }
    } catch (err) {
      if (!(err instanceof NpiError)) throw err;
      record(step, 'failed', null, err.messageAr, err.npiMessage);
      // Every later call would fail the same way; report them as failed
      // rather than hammer NPI with a dead token.
      if (err.kind === 'unauthorized') sessionLost = err;
    }
  }

  const counts: Record<StepOutcome, number> = { created: 0, updated: 0, skipped: 0, blocked: 0, failed: 0 };
  for (const r of results) counts[r.outcome] += 1;

  return {
    steps: results,
    gaps: plan.gaps,
    counts,
    departmentIdByCode,
    roleIdByKey,
    completed: counts.failed === 0,
  };
}

function ruleUpdateDto(step: ApprovalRuleStep, steps: { roleId: string }[]) {
  return {
    ...(step.existingMinAmount !== step.minAmount ? { minAmount: step.minAmount } : {}),
    maxAmount: step.maxAmount,
    steps,
    ...(step.reactivate ? { isActive: true } : {}),
  };
}

// ─── Copilot-side persistence ───────────────────────────────────────────────

/**
 * The subset of the copilot's Prisma client this file calls, typed
 * structurally (same reason as `PositionsDb` in `src/positions/resolve.ts`):
 * the real client and a small in-memory fake both satisfy it.
 */
export interface OnboardingDb {
  firmConfig: {
    upsert(args: {
      where: { npiOrgId: string };
      create: FirmConfigWrite & { npiOrgId: string };
      update: FirmConfigWrite;
    }): Promise<unknown>;
  };
  position: {
    findFirst(args: { where: { npiOrgId: string; roleKey: string; departmentId: string | null } }): Promise<{ id: string } | null>;
    create(args: {
      data: { npiOrgId: string; roleKey: string; departmentId: string | null; titleAr: string; personaAr: string };
    }): Promise<unknown>;
    update(args: { where: { id: string }; data: { titleAr: string; personaAr: string } }): Promise<unknown>;
  };
}

export interface FirmConfigWrite {
  profileKey: string;
  visibleModulesJson: string[];
  acceptedDocTypesJson: { key: string; labelAr: string; flow: string | null }[];
  terminologyJson: Record<string, string>;
  npiApiGapsJson: NpiApiGapsJson;
  setupCompletedAt?: Date | null;
}

/** What `firm_config.npiApiGapsJson` holds: the gaps proper, plus the steps
 *  NPI refused or could not take in the last run, so `/settings` can offer
 *  them again. */
export interface NpiApiGapsJson {
  gaps: NpiApiGap[];
  blocked: { stepId: string; reasonAr: string }[];
  failed: { stepId: string; reasonAr: string; npiMessage: string | null }[];
  appliedAt: string;
}

export interface PersistOutcome {
  positionsWritten: number;
  /** Positions whose department does not exist in NPI after the run. */
  positionsSkipped: { roleKey: string; departmentCode: string }[];
}

export async function persistCopilotConfig(
  db: OnboardingDb,
  args: { npiOrgId: string; plan: OnboardingPlan; result: ApplyResult; now?: () => Date },
): Promise<PersistOutcome> {
  const { npiOrgId, plan, result } = args;
  const now = (args.now ?? (() => new Date()))();

  const gapsJson: NpiApiGapsJson = {
    gaps: result.gaps,
    blocked: result.steps.filter((s) => s.outcome === 'blocked').map((s) => ({ stepId: s.stepId, reasonAr: s.reasonAr ?? '' })),
    failed: result.steps
      .filter((s) => s.outcome === 'failed')
      .map((s) => ({ stepId: s.stepId, reasonAr: s.reasonAr ?? '', npiMessage: s.npiMessage })),
    appliedAt: now.toISOString(),
  };
  const write: FirmConfigWrite = {
    profileKey: plan.copilot.profileKey,
    visibleModulesJson: plan.copilot.visibleModules,
    acceptedDocTypesJson: plan.copilot.acceptedDocTypes.map((d) => ({ key: d.key, labelAr: d.labelAr, flow: d.flow })),
    terminologyJson: { ...plan.copilot.terminology },
    npiApiGapsJson: gapsJson,
  };
  await db.firmConfig.upsert({
    where: { npiOrgId },
    create: { npiOrgId, ...write, setupCompletedAt: result.completed ? now : null },
    // An incomplete re-run must not erase the completion of an earlier one.
    update: result.completed ? { ...write, setupCompletedAt: now } : write,
  });

  let positionsWritten = 0;
  const positionsSkipped: PersistOutcome['positionsSkipped'] = [];
  for (const position of plan.copilot.positions) {
    let departmentId: string | null = null;
    if (position.departmentCode !== null) {
      const id = result.departmentIdByCode[position.departmentCode];
      if (id === undefined) {
        positionsSkipped.push({ roleKey: position.roleKey, departmentCode: position.departmentCode });
        continue;
      }
      departmentId = id;
    }
    const key = { npiOrgId, roleKey: position.roleKey, departmentId };
    const existing = await db.position.findFirst({ where: key });
    if (existing) {
      await db.position.update({ where: { id: existing.id }, data: { titleAr: position.titleAr, personaAr: position.personaAr } });
    } else {
      await db.position.create({ data: { ...key, titleAr: position.titleAr, personaAr: position.personaAr } });
    }
    positionsWritten += 1;
  }

  return { positionsWritten, positionsSkipped };
}
