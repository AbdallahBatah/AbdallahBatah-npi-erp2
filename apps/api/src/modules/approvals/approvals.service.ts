import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import {
  APPROVAL_DOCUMENT_META,
  bandsOverlap,
  type ApprovalDocumentType,
} from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import type { CreateApprovalRuleDto, UpdateApprovalRuleDto } from './dto';

const RULE_INCLUDE = {
  steps: {
    orderBy: { sequence: 'asc' },
    include: { role: { select: { id: true, key: true, nameAr: true, nameEn: true } } },
  },
  _count: { select: { requests: true } },
} as const;

/**
 * Configuration side of the approval matrix: the CRUD an administrator uses to
 * say "purchase orders above 100,000 need the project manager, then finance".
 *
 * Every guard here exists because the failure it prevents is silent. A band
 * that overlaps another makes approval depend on row order; a step whose role
 * cannot act on that document type opens chains nobody can close; a role with
 * no active users does the same. All three would present as "the system is
 * stuck" weeks later, with nothing in the logs.
 */
@Injectable()
export class ApprovalRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser) {
    return this.prisma.approvalRule.findMany({
      where: { organizationId: user.organizationId },
      include: RULE_INCLUDE,
      orderBy: [{ documentType: 'asc' }, { minAmount: 'asc' }],
    });
  }

  async create(user: AuthUser, dto: CreateApprovalRuleDto) {
    const max = dto.maxAmount ?? null;
    await this.validateBand(user, dto.documentType, dto.minAmount, max, null);
    await this.validateSteps(user, dto.documentType, dto.steps.map((s) => s.roleId));

    const rule = await this.prisma.approvalRule.create({
      data: {
        organizationId: user.organizationId,
        documentType: dto.documentType,
        minAmount: dto.minAmount,
        maxAmount: max,
        isActive: dto.isActive ?? true,
        steps: {
          create: dto.steps.map((s, i) => ({ sequence: i + 1, roleId: s.roleId })),
        },
      },
      include: RULE_INCLUDE,
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'ApprovalRule',
      entityId: rule.id,
      action: 'CREATE',
      after: {
        documentType: dto.documentType,
        minAmount: dto.minAmount,
        maxAmount: max,
        steps: rule.steps.map((s) => s.role.key),
      },
    });
    return rule;
  }

  async update(user: AuthUser, id: string, dto: UpdateApprovalRuleDto) {
    const rule = await this.getOwned(user, id);
    const documentType = rule.documentType as ApprovalDocumentType;
    const min = dto.minAmount ?? Number(rule.minAmount);
    const max =
      dto.maxAmount === undefined
        ? rule.maxAmount === null
          ? null
          : Number(rule.maxAmount)
        : dto.maxAmount;
    const active = dto.isActive ?? rule.isActive;

    if (active) await this.validateBand(user, documentType, min, max, rule.id);
    if (dto.steps) {
      await this.validateSteps(user, documentType, dto.steps.map((s) => s.roleId));
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.steps) {
        // Replace wholesale rather than diff: the chain is an ordered list, and
        // already-issued requests hold their own copy of the steps, so nothing
        // in flight is disturbed by rewriting the template.
        await tx.approvalRuleStep.deleteMany({ where: { ruleId: rule.id } });
        await tx.approvalRuleStep.createMany({
          data: dto.steps.map((s, i) => ({ ruleId: rule.id, sequence: i + 1, roleId: s.roleId })),
        });
      }
      return tx.approvalRule.update({
        where: { id: rule.id },
        data: { minAmount: min, maxAmount: max, isActive: active },
        include: RULE_INCLUDE,
      });
    });

    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'ApprovalRule',
      entityId: rule.id,
      action: 'UPDATE',
      before: {
        minAmount: Number(rule.minAmount),
        maxAmount: rule.maxAmount === null ? null : Number(rule.maxAmount),
        isActive: rule.isActive,
        steps: rule.steps.map((s) => s.role.key),
      },
      after: {
        minAmount: min,
        maxAmount: max,
        isActive: active,
        steps: updated.steps.map((s) => s.role.key),
      },
    });
    return updated;
  }

  async remove(user: AuthUser, id: string) {
    const rule = await this.getOwned(user, id);
    const pending = await this.prisma.approvalRequest.count({
      where: { ruleId: rule.id, status: 'PENDING' },
    });
    if (pending > 0) {
      throw new BadRequestException(
        'This rule still has documents awaiting approval — decide them first, or deactivate the rule instead',
      );
    }
    // Requests keep pointing at a deleted rule via SET NULL, so history survives.
    await this.prisma.approvalRule.delete({ where: { id: rule.id } });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'ApprovalRule',
      entityId: rule.id,
      action: 'DELETE',
      before: {
        documentType: rule.documentType,
        minAmount: Number(rule.minAmount),
        maxAmount: rule.maxAmount === null ? null : Number(rule.maxAmount),
      },
    });
    return { ok: true };
  }

  // ── guards ────────────────────────────────────────────────────────────────

  private async getOwned(user: AuthUser, id: string) {
    const rule = await this.prisma.approvalRule.findFirst({
      where: { id, organizationId: user.organizationId },
      include: RULE_INCLUDE,
    });
    if (!rule) throw new NotFoundException('Approval rule not found');
    return rule;
  }

  /** No two active bands of one document type may cover the same amount. */
  private async validateBand(
    user: AuthUser,
    documentType: ApprovalDocumentType,
    min: number,
    max: number | null,
    excludeRuleId: string | null,
  ) {
    if (max !== null && max <= min) {
      throw new BadRequestException('maxAmount must be greater than minAmount');
    }
    const siblings = await this.prisma.approvalRule.findMany({
      where: {
        organizationId: user.organizationId,
        documentType,
        isActive: true,
        ...(excludeRuleId ? { id: { not: excludeRuleId } } : {}),
      },
    });
    const clash = siblings.find((s) =>
      bandsOverlap(
        { min, max },
        { min: Number(s.minAmount), max: s.maxAmount === null ? null : Number(s.maxAmount) },
      ),
    );
    if (clash) {
      throw new BadRequestException(
        `This amount band overlaps an existing rule (${Number(clash.minAmount)} – ${clash.maxAmount === null ? '∞' : Number(clash.maxAmount)})`,
      );
    }
  }

  /**
   * Every step must name a role of this organization that (a) holds the write
   * permission for the document type — deciding is the same authority as doing,
   * and a role without it could never act — and (b) has at least one active
   * user, or the chain stops at that step forever. Repeats are refused too: the
   * same role signing twice is one signature wearing two hats.
   */
  private async validateSteps(
    user: AuthUser,
    documentType: ApprovalDocumentType,
    roleIds: string[],
  ) {
    if (new Set(roleIds).size !== roleIds.length) {
      throw new BadRequestException('A role cannot appear twice in the same chain');
    }
    const required = APPROVAL_DOCUMENT_META[documentType].permission;
    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds }, organizationId: user.organizationId },
      include: { _count: { select: { users: true } } },
    });
    const byId = new Map(roles.map((r) => [r.id, r]));

    for (const roleId of roleIds) {
      const role = byId.get(roleId);
      if (!role) throw new NotFoundException('Role not found');
      if (!role.permissions.includes(required)) {
        throw new BadRequestException(
          `Role "${role.nameEn}" cannot approve this document type — it lacks ${required}`,
        );
      }
    }

    const activeCounts = await this.prisma.user.groupBy({
      by: ['roleId'],
      where: { organizationId: user.organizationId, isActive: true, roleId: { in: roleIds } },
      _count: { _all: true },
    });
    const withUsers = new Set(activeCounts.map((c) => c.roleId));
    // A role held only as someone's *extra* role still has a person to sign.
    const extraHolders = await this.prisma.userRole.findMany({
      where: { roleId: { in: roleIds }, user: { organizationId: user.organizationId, isActive: true } },
      select: { roleId: true },
    });
    for (const h of extraHolders) withUsers.add(h.roleId);
    const empty = roleIds.find((r) => !withUsers.has(r));
    if (empty) {
      throw new BadRequestException(
        `Role "${byId.get(empty)?.nameEn}" has no active users — a chain that reaches it would never move`,
      );
    }
  }
}
