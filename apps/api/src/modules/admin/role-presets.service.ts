import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import {
  APPROVAL_DOCUMENT_META,
  PERMISSION_CATALOG,
  PERMISSIONS,
  PROPOSED_APPROVAL_RULES,
  ROLE_PRESETS,
  SCREENS,
  rolePreset,
  sodConflicts,
  visibleScreens,
  type ApprovalDocumentType,
  type ProposedApprovalRule,
  type RolePreset,
} from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import type { AuthUser } from '../../common/auth-user';
import { ApprovalRulesService } from '../approvals/approvals.service';
import { AdminService, type ApprovalSeats } from './admin.service';

/** Against the organization's role of the preset's key. */
export type PresetStatus = 'create' | 'same' | 'differs';
/** A proposed rule whose chain names a role that could not sign yet is `blocked`. */
export type RuleStatus = PresetStatus | 'blocked';

/**
 * Why applying a preset would be refused today, computed without writing:
 * the same two guards `AdminService.updateRole` runs inside its transaction.
 */
export type PresetBlock =
  /** Hard rule 4: no active user would hold `admin.user.manage` effectively. */
  | { code: 'LAST_ADMIN' }
  /** Hard rule 8: the role signs, with an approve key the preset drops, in these rules or open requests. */
  | ({ code: 'APPROVAL_SEAT' } & ApprovalSeats);

/** Why a proposed rule cannot be applied yet (what ApprovalRulesService would refuse). */
export type RuleBlock =
  /** The preset that creates the role has not been applied. */
  | { code: 'ROLE_MISSING'; role: string }
  /** The role lacks the document's approve key (APPROVAL_DOCUMENTS). */
  | { code: 'ROLE_LACKS_KEY'; role: string; permission: string }
  /** No active user holds the role, so a chain reaching it would never move. */
  | { code: 'ROLE_NO_USERS'; role: string };

interface NamedRole {
  key: string;
  nameAr: string | null;
  nameEn: string | null;
}

export interface PresetDiff {
  key: string;
  status: PresetStatus;
  /** The organization's role of that key; null when the apply would create it. */
  roleId: string | null;
  currentName: { nameAr: string; nameEn: string } | null;
  proposedName: { nameAr: string; nameEn: string };
  renamed: boolean;
  /** How many keys the role holds today; null when it does not exist. */
  currentCount: number | null;
  /** The preset's keys, in catalogue order. */
  permissions: string[];
  /** Keys the apply adds and removes, in catalogue order. */
  added: string[];
  removed: string[];
  /** Sidebar screens a holder of the preset alone sees (`visibleScreens`), of `totalScreens`. */
  screens: number;
  totalScreens: number;
  /** Active users whose primary or extra role it is: whom the apply changes at once. */
  affectedUsers: Array<{ id: string; nameAr: string; nameEn: string; email: string; primary: boolean }>;
  /** The SOD_CONFLICTS pairs the preset holds; informational, acknowledged on apply. */
  sodConflicts: Array<{ a: string; b: string; labelAr: string; labelEn: string }>;
  blockedBy: PresetBlock[];
}

export interface RuleDiff {
  documentType: ApprovalDocumentType;
  minAmount: 0;
  maxAmount: null;
  /** The proposed chain, with the organization's role of each key when it exists. */
  steps: Array<NamedRole & { roleId: string | null }>;
  status: RuleStatus;
  /** The ACTIVE rules of that document type today, lowest band first. */
  current: Array<{ id: string; minAmount: number; maxAmount: number | null; steps: NamedRole[] }>;
  /**
   * What applying does: `update` gets the proposed band and chain (null =
   * create a new rule) and every rule in `deactivate` is switched off.
   * Null when the rule is already `same`.
   */
  change: { update: string | null; deactivate: string[] } | null;
  blockedBy: RuleBlock[];
}

export interface PresetsOverview {
  presets: PresetDiff[];
  rules: RuleDiff[];
}

export type RuleOutcome =
  | { documentType: ApprovalDocumentType; outcome: 'same' }
  | { documentType: ApprovalDocumentType; outcome: 'blocked'; blockedBy: RuleBlock[] }
  | { documentType: ApprovalDocumentType; outcome: 'created'; ruleId: string }
  | { documentType: ApprovalDocumentType; outcome: 'updated'; ruleId: string; deactivated: string[] }
  | {
      documentType: ApprovalDocumentType;
      outcome: 'failed';
      error: string;
      /** Rules switched off before the failure that could not be switched back on. */
      deactivated: string[];
    };

interface RoleRow {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string;
  permissions: string[];
}

const ROLE_SELECT = { id: true, key: true, nameAr: true, nameEn: true, permissions: true } as const;

/** Catalogue order; a key the catalogue does not know (a legacy one on a live role) goes last. */
const CATALOGUE_INDEX = new Map<string, number>(PERMISSION_CATALOG.map((p, i) => [p.key, i]));
const byCatalogue = (a: string, b: string) =>
  (CATALOGUE_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER) -
    (CATALOGUE_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b, 'en');

const sameSteps = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * The seven company role presets and the five proposed approval rules
 * (ADR-02 §3-4, task 9): a preview of each against the organization as it is
 * now, and the owner's one-click apply of one preset, or of the five rules,
 * at a time.
 *
 * Nothing here writes on its own account. A preset is applied through
 * `AdminService.createRole` / `updateRole` and the rules through
 * `ApprovalRulesService`, so their guards (lockout, approval seat, band
 * overlap, a chain only roles that can sign) and their audit rows all apply;
 * the preview asks the same two role guards read-only. Users are never moved
 * and a role no preset names (`admin`, `sales`, any other) is never touched.
 */
@Injectable()
export class RolePresetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admin: AdminService,
    private readonly approvals: ApprovalRulesService,
  ) {}

  // ── preview ───────────────────────────────────────────────────────────────

  async overview(user: AuthUser): Promise<PresetsOverview> {
    const organizationId = user.organizationId;
    const [roles, activeRules] = await Promise.all([
      this.prisma.role.findMany({
        where: { organizationId, key: { in: ROLE_PRESETS.map((p) => p.key) } },
        select: ROLE_SELECT,
      }),
      this.prisma.approvalRule.findMany({
        where: {
          organizationId,
          isActive: true,
          documentType: { in: PROPOSED_APPROVAL_RULES.map((r) => r.documentType) },
        },
        select: {
          id: true,
          documentType: true,
          minAmount: true,
          maxAmount: true,
          steps: {
            orderBy: { sequence: 'asc' },
            select: { role: { select: { key: true, nameAr: true, nameEn: true } } },
          },
        },
        orderBy: [{ documentType: 'asc' }, { minAmount: 'asc' }],
      }),
    ]);
    const byKey = new Map(roles.map((r) => [r.key, r]));

    // Every active user holding one of these roles, primary or extra, in one read.
    const roleIds = roles.map((r) => r.id);
    const holders = roleIds.length
      ? await this.prisma.user.findMany({
          where: {
            organizationId,
            isActive: true,
            OR: [{ roleId: { in: roleIds } }, { extraRoles: { some: { roleId: { in: roleIds } } } }],
          },
          select: {
            id: true,
            nameAr: true,
            nameEn: true,
            email: true,
            roleId: true,
            extraRoles: { select: { roleId: true } },
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const holdersOf = (roleId: string) =>
      holders
        .filter((u) => u.roleId === roleId || u.extraRoles.some((er) => er.roleId === roleId))
        .map((u) => ({
          id: u.id,
          nameAr: u.nameAr,
          nameEn: u.nameEn,
          email: u.email,
          primary: u.roleId === roleId,
        }));

    const presets: PresetDiff[] = [];
    for (const preset of ROLE_PRESETS) {
      const role = byKey.get(preset.key) ?? null;
      const diff = diffPreset(preset, role);
      presets.push({
        ...diff,
        affectedUsers: role ? holdersOf(role.id) : [],
        blockedBy:
          role && diff.status === 'differs'
            ? await this.blockersOf(organizationId, role, diff.removed)
            : [],
      });
    }

    const rules = PROPOSED_APPROVAL_RULES.map((proposed) =>
      diffRule(
        proposed,
        byKey,
        activeRules
          .filter((r) => r.documentType === proposed.documentType)
          .map((r) => ({
            id: r.id,
            minAmount: Number(r.minAmount),
            maxAmount: r.maxAmount === null ? null : Number(r.maxAmount),
            steps: r.steps.map((s) => ({ key: s.role.key, nameAr: s.role.nameAr, nameEn: s.role.nameEn })),
          })),
        (roleId) => holdersOf(roleId).length > 0,
      ),
    );
    return { presets, rules };
  }

  /**
   * The two guards `AdminService.updateRole` would run on this save, asked
   * without writing: the lockout (only when the role holds
   * `admin.user.manage` today, since no preset does) and the approval seat
   * (only the approve keys among `removed` are looked at).
   */
  private async blockersOf(
    organizationId: string,
    role: RoleRow,
    removed: string[],
  ): Promise<PresetBlock[]> {
    const blocks: PresetBlock[] = [];
    if (removed.includes(PERMISSIONS.USER_MANAGE)) {
      const left = await this.admin.countAdministrators(organizationId, role.id);
      if (left === 0) blocks.push({ code: 'LAST_ADMIN' });
    }
    const seats = await this.admin.findApprovalSeats(organizationId, role.id, removed);
    if (seats) blocks.push({ code: 'APPROVAL_SEAT', ...seats });
    return blocks;
  }

  // ── apply ─────────────────────────────────────────────────────────────────

  /**
   * Applies one preset: creates the role, or renames it and replaces its keys
   * with the preset's, through the role service (its lockout and
   * approval-seat guards refuse what the preview's `blockedBy` predicts). The
   * separation-of-duties pairs the preset holds are acknowledged
   * (`acknowledgeSod: true`): the owner saw them on the card. A second row,
   * PRESET_APPLY, records that the change came from the preset. Idempotent:
   * a preset already `same` writes and audits nothing.
   */
  async applyPreset(user: AuthUser, key: string) {
    const preset = rolePreset(key);
    if (!preset) throw new NotFoundException('Role preset not found');
    const organizationId = user.organizationId;
    const role = await this.prisma.role.findUnique({
      where: { organizationId_key: { organizationId, key: preset.key } },
      select: ROLE_SELECT,
    });
    const diff = diffPreset(preset, role);

    if (role && diff.status === 'same') {
      const unchanged = await this.prisma.role.findUniqueOrThrow({
        where: { id: role.id },
        include: { _count: { select: { users: true } } },
      });
      return { applied: false, role: unchanged, ...(await this.overview(user)) };
    }

    const permissions = [...diff.permissions];
    const saved = role
      ? await this.admin.updateRole(user, role.id, {
          nameAr: preset.nameAr,
          nameEn: preset.nameEn,
          permissions,
          acknowledgeSod: true,
        })
      : await this.admin.createRole(user, {
          key: preset.key,
          nameAr: preset.nameAr,
          nameEn: preset.nameEn,
          permissions,
          acknowledgeSod: true,
        });
    await this.audit.record({
      organizationId,
      actorId: user.userId,
      entityType: 'Role',
      entityId: saved.id,
      action: 'PRESET_APPLY',
      before: role ? { nameAr: role.nameAr, nameEn: role.nameEn } : null,
      after: {
        preset: preset.key,
        created: !role,
        nameAr: preset.nameAr,
        nameEn: preset.nameEn,
        added: diff.added,
        removed: diff.removed,
        ...(diff.sodConflicts.length
          ? { sodConflicts: diff.sodConflicts.map(({ a, b }) => ({ a, b })), sodAcknowledged: true }
          : {}),
      },
    });
    return { applied: true, role: saved, ...(await this.overview(user)) };
  }

  /**
   * Applies the five proposed rules in order through the matrix service. A
   * `same` rule is left alone and a `blocked` one skipped and reported. For a
   * document type that already has active rules, the first (lowest band) is
   * UPDATED to the proposed band and chain and the others are switched off,
   * rather than a new rule being added: the proposed band [0, ∞) covers every
   * amount, so any other active band of the type would overlap it, and
   * switching off (not deleting) keeps their history. They are switched off
   * first, because the band check would refuse the widened rule while they
   * are still active; if the update then fails they are switched back on.
   * Requests already in flight keep their own copy of the steps. Each write
   * is audited by the matrix service's own rows.
   */
  async applyRules(user: AuthUser) {
    const { rules } = await this.overview(user);
    const outcomes: RuleOutcome[] = [];
    for (const rule of rules) {
      outcomes.push(await this.applyRule(user, rule));
    }
    return { outcomes, ...(await this.overview(user)) };
  }

  private async applyRule(user: AuthUser, rule: RuleDiff): Promise<RuleOutcome> {
    const { documentType } = rule;
    if (rule.status === 'same' || !rule.change) return { documentType, outcome: 'same' };
    if (rule.status === 'blocked') return { documentType, outcome: 'blocked', blockedBy: rule.blockedBy };

    // Not blocked, so every step's role exists.
    const steps = rule.steps.map((s) => ({ roleId: s.roleId as string }));
    const target = rule.change.update;
    if (target === null) {
      try {
        const created = await this.approvals.create(user, {
          documentType,
          minAmount: 0,
          maxAmount: null,
          isActive: true,
          steps,
        });
        return { documentType, outcome: 'created', ruleId: created.id };
      } catch (e) {
        return { documentType, outcome: 'failed', error: refusal(e), deactivated: [] };
      }
    }

    const switchedOff: string[] = [];
    try {
      for (const id of rule.change.deactivate) {
        await this.approvals.update(user, id, { isActive: false });
        switchedOff.push(id);
      }
      await this.approvals.update(user, target, { minAmount: 0, maxAmount: null, isActive: true, steps });
      return { documentType, outcome: 'updated', ruleId: target, deactivated: switchedOff };
    } catch (e) {
      const error = refusal(e);
      const stillOff: string[] = [];
      for (const id of switchedOff) {
        try {
          await this.approvals.update(user, id, { isActive: true });
        } catch {
          stillOff.push(id);
        }
      }
      return { documentType, outcome: 'failed', error, deactivated: stillOff };
    }
  }
}

/** The message of a refusal (an HttpException); anything else is not a refusal and is rethrown. */
function refusal(e: unknown): string {
  if (e instanceof HttpException) return e.message;
  throw e;
}

/** A preset against the organization's role of its key: status, names and the key diff. */
function diffPreset(
  preset: RolePreset,
  role: RoleRow | null,
): Omit<PresetDiff, 'affectedUsers' | 'blockedBy'> {
  const permissions = [...preset.permissions].sort(byCatalogue);
  const proposed = new Set<string>(permissions);
  const current = new Set(role?.permissions ?? []);
  const added = permissions.filter((k) => !current.has(k));
  const removed = [...current].filter((k) => !proposed.has(k)).sort(byCatalogue);
  const renamed = !!role && (role.nameAr !== preset.nameAr || role.nameEn !== preset.nameEn);
  let status: PresetStatus = 'differs';
  if (!role) status = 'create';
  else if (added.length === 0 && removed.length === 0 && !renamed) status = 'same';
  return {
    key: preset.key,
    status,
    roleId: role?.id ?? null,
    currentName: role ? { nameAr: role.nameAr, nameEn: role.nameEn } : null,
    proposedName: { nameAr: preset.nameAr, nameEn: preset.nameEn },
    renamed,
    currentCount: role ? current.size : null,
    permissions,
    added,
    removed,
    screens: visibleScreens(permissions).length,
    totalScreens: SCREENS.length,
    sodConflicts: sodConflicts(permissions).map(({ a, b, labelAr, labelEn }) => ({
      a,
      b,
      labelAr,
      labelEn,
    })),
  };
}

/**
 * A proposed rule against the active rules of its document type. `same`: one
 * active rule, from zero with no ceiling, with the proposed chain. `blocked`:
 * a step's role is missing, lacks the document's approve key or has no active
 * holder (what ApprovalRulesService.validateSteps would refuse).
 */
function diffRule(
  proposed: ProposedApprovalRule,
  roles: ReadonlyMap<string, RoleRow>,
  current: RuleDiff['current'],
  hasActiveHolder: (roleId: string) => boolean,
): RuleDiff {
  const permission = APPROVAL_DOCUMENT_META[proposed.documentType].permission;
  const steps = proposed.steps.map((key) => {
    const role = roles.get(key);
    return { key, roleId: role?.id ?? null, nameAr: role?.nameAr ?? null, nameEn: role?.nameEn ?? null };
  });
  const same =
    current.length === 1 &&
    current[0].minAmount === 0 &&
    current[0].maxAmount === null &&
    sameSteps(
      current[0].steps.map((s) => s.key),
      proposed.steps,
    );
  const blockedBy: RuleBlock[] = [];
  if (!same) {
    for (const key of proposed.steps) {
      const role = roles.get(key);
      if (!role) blockedBy.push({ code: 'ROLE_MISSING', role: key });
      else if (!role.permissions.includes(permission)) {
        blockedBy.push({ code: 'ROLE_LACKS_KEY', role: key, permission });
      } else if (!hasActiveHolder(role.id)) blockedBy.push({ code: 'ROLE_NO_USERS', role: key });
    }
  }
  let status: RuleStatus = current.length ? 'differs' : 'create';
  if (same) status = 'same';
  else if (blockedBy.length) status = 'blocked';
  return {
    documentType: proposed.documentType,
    minAmount: 0,
    maxAmount: null,
    steps,
    status,
    current,
    change: same
      ? null
      : { update: current[0]?.id ?? null, deactivate: current.slice(1).map((r) => r.id) },
    blockedBy,
  };
}
