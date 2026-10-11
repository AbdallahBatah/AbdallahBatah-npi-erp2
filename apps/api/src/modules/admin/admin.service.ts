import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { Prisma } from '@npi/db';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { ALL_PERMISSIONS, PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';
import { CreateRoleDto, CreateUserDto, ResetPasswordDto, UpdateOrgDto, UpdateRoleDto, UpdateUserDto } from './dto';

const ORG_SELECT = {
  id: true,
  legalNameAr: true,
  legalNameEn: true,
  vatNumber: true,
  crNumber: true,
  addressAr: true,
  addressEn: true,
  phone: true,
  email: true,
  website: true,
  logoDataUrl: true,
  baseCurrency: true,
} as const;

const USER_SELECT = {
  id: true,
  email: true,
  nameAr: true,
  nameEn: true,
  locale: true,
  isActive: true,
  createdAt: true,
  role: { select: { id: true, key: true, nameAr: true, nameEn: true } },
  extraRoles: {
    select: { role: { select: { id: true, key: true, nameAr: true, nameEn: true } } },
    orderBy: { createdAt: 'asc' },
  },
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/**
 * Flatten `extraRoles: [{ role }]` into `roles: [role, ...]` — the primary role
 * first, then the extra ones — so the web app has one list to render as badges.
 * `role` stays as the primary (unchanged shape for existing readers).
 */
function shapeUser(row: UserRow) {
  const { extraRoles, ...rest } = row;
  return { ...rest, roles: [row.role, ...extraRoles.map((er) => er.role)] };
}

/** A user holds `permission` through their primary role or any extra role. */
const holdsPermission = (permission: string): Prisma.UserWhereInput => ({
  OR: [
    { role: { permissions: { has: permission } } },
    { extraRoles: { some: { role: { permissions: { has: permission } } } } },
  ],
});

/**
 * User & role administration. The one invariant everything here protects:
 * the organization must never end up without an active user who can manage
 * users — a locked-out tenant is unrecoverable without database surgery.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── users ─────────────────────────────────────────────────────────────────

  async listUsers(user: AuthUser) {
    const rows = await this.prisma.user.findMany({
      where: { organizationId: user.organizationId },
      select: USER_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(shapeUser);
  }

  /**
   * Validates a requested set of extra roles: every one belongs to this
   * organization, none is the primary role (it would be held twice), no
   * duplicates. Returns the ids.
   */
  private async validateExtraRoles(
    organizationId: string,
    primaryRoleId: string,
    extraRoleIds: string[],
  ): Promise<string[]> {
    const ids = [...new Set(extraRoleIds)];
    if (ids.length !== extraRoleIds.length) {
      throw new BadRequestException('Extra roles must not contain duplicates');
    }
    if (ids.includes(primaryRoleId)) {
      throw new BadRequestException('The primary role cannot also be an extra role');
    }
    if (ids.length) {
      const owned = await this.prisma.role.count({ where: { id: { in: ids }, organizationId } });
      if (owned !== ids.length) throw new NotFoundException('Role not found');
    }
    return ids;
  }

  private async getRoleOwned(organizationId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, organizationId },
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async createUser(user: AuthUser, dto: CreateUserDto) {
    const email = dto.email.toLowerCase();
    // User.email is globally unique — pre-check for a message the web app can
    // translate (the P2002 fallback is a generic DUPLICATE).
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new BadRequestException('Email already in use');
    await this.getRoleOwned(user.organizationId, dto.roleId);
    const extraRoleIds = await this.validateExtraRoles(
      user.organizationId,
      dto.roleId,
      dto.extraRoleIds ?? [],
    );

    const nameAr = dto.nameAr.trim();
    const nameEn = (dto.nameEn ?? '').trim() || nameAr;
    const created = await this.prisma.user.create({
      data: {
        organizationId: user.organizationId,
        email,
        passwordHash: await bcrypt.hash(dto.password, 10),
        nameAr,
        nameEn,
        locale: dto.locale ?? 'AR',
        roleId: dto.roleId,
        extraRoles: { create: extraRoleIds.map((roleId) => ({ roleId })) },
      },
      select: USER_SELECT,
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'User',
      entityId: created.id,
      action: 'CREATE',
      after: { email, nameAr, roleId: dto.roleId, extraRoleIds },
    });
    return shapeUser(created);
  }

  async updateUser(user: AuthUser, id: string, dto: UpdateUserDto) {
    const target = await this.prisma.user.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { role: true, extraRoles: { include: { role: true } } },
    });
    if (!target) throw new NotFoundException('User not found');

    if (dto.isActive === false && id === user.userId) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    const newPrimary =
      dto.roleId && dto.roleId !== target.roleId
        ? await this.getRoleOwned(user.organizationId, dto.roleId)
        : target.role;

    // The extra roles after this update. Omitted → unchanged, except that a
    // role promoted to primary stops being an extra (it would be held twice).
    const currentExtraIds = target.extraRoles.map((er) => er.roleId);
    const nextExtraIds =
      dto.extraRoleIds !== undefined
        ? await this.validateExtraRoles(user.organizationId, newPrimary.id, dto.extraRoleIds)
        : currentExtraIds.filter((rid) => rid !== newPrimary.id);
    const extraRolesChanged =
      dto.extraRoleIds !== undefined || nextExtraIds.length !== currentExtraIds.length;

    // Lockout guard: would this update strip the org's last active user-manager?
    // A user manages users through their primary role OR any extra role.
    const holdsNow =
      target.role.permissions.includes(PERMISSIONS.USER_MANAGE) ||
      target.extraRoles.some((er) => er.role.permissions.includes(PERMISSIONS.USER_MANAGE));
    let holdsAfter = newPrimary.permissions.includes(PERMISSIONS.USER_MANAGE);
    if (!holdsAfter && nextExtraIds.length) {
      const nextExtras = await this.prisma.role.findMany({
        where: { id: { in: nextExtraIds }, organizationId: user.organizationId },
        select: { permissions: true },
      });
      holdsAfter = nextExtras.some((r) => r.permissions.includes(PERMISSIONS.USER_MANAGE));
    }
    const losesManage = holdsNow && (dto.isActive === false || !holdsAfter);
    if (losesManage) await this.assertAnotherManagerExists(user.organizationId, target.id);

    // Primary role, flags and the extra-role set change together or not at all.
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          nameAr: dto.nameAr?.trim() || undefined,
          nameEn: dto.nameEn?.trim() || undefined,
          roleId: dto.roleId,
          isActive: dto.isActive,
          locale: dto.locale,
        },
      });
      if (extraRolesChanged) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        if (nextExtraIds.length) {
          await tx.userRole.createMany({
            data: nextExtraIds.map((roleId) => ({ userId: id, roleId })),
          });
        }
      }
      return tx.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'User',
      entityId: id,
      action: 'UPDATE',
      before: {
        roleId: target.roleId,
        extraRoleIds: currentExtraIds,
        isActive: target.isActive,
        nameAr: target.nameAr,
      },
      after: { ...(dto as unknown as Record<string, unknown>), extraRoleIds: nextExtraIds },
    });
    return shapeUser(updated);
  }

  /** Admin sets a new password for a colleague who forgot theirs. */
  async resetPassword(user: AuthUser, id: string, dto: ResetPasswordDto) {
    const target = await this.prisma.user.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!target) throw new NotFoundException('User not found');
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 10) },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'User',
      entityId: id,
      action: 'PASSWORD_RESET',
    });
    return { ok: true };
  }

  /** 400 unless at least one OTHER active user still holds admin.user.manage. */
  private async assertAnotherManagerExists(organizationId: string, excludeUserId: string) {
    const others = await this.prisma.user.count({
      where: {
        organizationId,
        isActive: true,
        id: { not: excludeUserId },
        ...holdsPermission(PERMISSIONS.USER_MANAGE),
      },
    });
    if (others === 0) {
      throw new BadRequestException('Cannot remove the last active administrator');
    }
  }

  // ── roles ─────────────────────────────────────────────────────────────────

  listRoles(user: AuthUser) {
    return this.prisma.role.findMany({
      where: { organizationId: user.organizationId },
      include: { _count: { select: { users: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  private validatePermissions(permissions: string[]): string[] {
    const valid = new Set<string>(ALL_PERMISSIONS);
    const unknown = permissions.filter((p) => !valid.has(p));
    if (unknown.length) {
      throw new BadRequestException(`Unknown permission key: ${unknown.join(', ')}`);
    }
    return [...new Set(permissions)];
  }

  async createRole(user: AuthUser, dto: CreateRoleDto) {
    const exists = await this.prisma.role.findUnique({
      where: { organizationId_key: { organizationId: user.organizationId, key: dto.key } },
    });
    if (exists) throw new BadRequestException('Role key already in use');
    const nameAr = dto.nameAr.trim();
    const nameEn = (dto.nameEn ?? '').trim() || nameAr;
    const role = await this.prisma.role.create({
      data: {
        organizationId: user.organizationId,
        key: dto.key,
        nameAr,
        nameEn,
        permissions: this.validatePermissions(dto.permissions),
      },
      include: { _count: { select: { users: true } } },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Role',
      entityId: role.id,
      action: 'CREATE',
      after: { key: dto.key, nameAr, permissions: role.permissions },
    });
    return role;
  }

  async updateRole(user: AuthUser, id: string, dto: UpdateRoleDto) {
    const role = await this.getRoleOwned(user.organizationId, id);

    let permissions: string[] | undefined;
    if (dto.permissions) {
      permissions = this.validatePermissions(dto.permissions);
      // Lockout guard: stripping user-management from this role must leave the
      // org at least one active manager through some other role.
      if (
        role.permissions.includes(PERMISSIONS.USER_MANAGE) &&
        !permissions.includes(PERMISSIONS.USER_MANAGE)
      ) {
        const others = await this.prisma.user.count({
          where: {
            organizationId: user.organizationId,
            isActive: true,
            // Another user keeps user-management through some role OTHER than
            // the one being edited — as their primary or as an extra role.
            OR: [
              { roleId: { not: role.id }, role: { permissions: { has: PERMISSIONS.USER_MANAGE } } },
              {
                extraRoles: {
                  some: {
                    roleId: { not: role.id },
                    role: { permissions: { has: PERMISSIONS.USER_MANAGE } },
                  },
                },
              },
            ],
          },
        });
        if (others === 0) {
          throw new BadRequestException(
            'Cannot remove user management from the last administrator role',
          );
        }
      }
    }

    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        nameAr: dto.nameAr?.trim() || undefined,
        nameEn: dto.nameEn?.trim() || undefined,
        permissions,
      },
      include: { _count: { select: { users: true } } },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Role',
      entityId: id,
      action: 'UPDATE',
      before: { permissions: role.permissions, nameAr: role.nameAr },
      after: { permissions: updated.permissions, nameAr: updated.nameAr },
    });
    return updated;
  }

  async deleteRole(user: AuthUser, id: string) {
    const role = await this.getRoleOwned(user.organizationId, id);
    const assigned =
      (await this.prisma.user.count({ where: { roleId: id } })) +
      (await this.prisma.userRole.count({ where: { roleId: id } }));
    if (assigned > 0) {
      throw new BadRequestException('Role still has users assigned — reassign them first');
    }
    // The approval matrix references roles by id. Both checks turn what would
    // otherwise surface as a raw foreign-key error into something the admin
    // can act on — and the second one is permanent by design: a role that ever
    // signed something cannot be deleted without erasing who signed it.
    const inMatrix = await this.prisma.approvalRuleStep.count({ where: { roleId: id } });
    if (inMatrix > 0) {
      throw new BadRequestException(
        'Role is used in the approval matrix — remove it from those rules first',
      );
    }
    const hasSigned = await this.prisma.approvalStep.count({ where: { roleId: id } });
    if (hasSigned > 0) {
      throw new BadRequestException(
        'Role appears in the approval history and cannot be deleted — deactivate its users instead',
      );
    }
    await this.prisma.role.delete({ where: { id } });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Role',
      entityId: id,
      action: 'DELETE',
      before: { key: role.key, nameAr: role.nameAr },
    });
    return { ok: true };
  }

  // ── organization settings ────────────────────────────────────────────────

  getOrg(user: AuthUser) {
    return this.prisma.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: ORG_SELECT,
    });
  }

  async updateOrg(user: AuthUser, dto: UpdateOrgDto) {
    const before = await this.prisma.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: ORG_SELECT,
    });
    const updated = await this.prisma.organization.update({
      where: { id: user.organizationId },
      data: {
        legalNameAr: dto.legalNameAr?.trim() || undefined,
        legalNameEn: dto.legalNameEn?.trim() || undefined,
        vatNumber: dto.vatNumber?.trim(),
        crNumber: dto.crNumber?.trim(),
        addressAr: dto.addressAr?.trim(),
        addressEn: dto.addressEn?.trim(),
        phone: dto.phone?.trim(),
        email: dto.email?.trim(),
        website: dto.website?.trim(),
        logoDataUrl: dto.logoDataUrl,
      },
      select: ORG_SELECT,
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Organization',
      entityId: user.organizationId,
      action: 'UPDATE',
      before: { ...before, logoDataUrl: before.logoDataUrl ? '[omitted]' : null },
      after: { ...updated, logoDataUrl: updated.logoDataUrl ? '[omitted]' : null },
    });
    return updated;
  }

  // ── audit trail (read side) ───────────────────────────────────────────────

  /**
   * The trail was write-only until now, which made "who changed what, when"
   * unanswerable through the system — flagged as a control gap in the
   * 2026-08-01 UAT. Read-only by construction: this class never exposes an
   * update or delete on AuditLog.
   */
  async listAudit(user: AuthUser, filter: AuditFilter) {
    const where: Prisma.AuditLogWhereInput = {
      organizationId: user.organizationId,
      entityType: filter.entityType || undefined,
      entityId: filter.entityId || undefined,
      action: filter.action || undefined,
      actorId: filter.actorId || undefined,
    };
    if (filter.from || filter.to) {
      const from = filter.from ? new Date(filter.from) : undefined;
      // A bare YYYY-MM-DD "to" means "through that day", so push it to the
      // last millisecond — same convention as the finance reports.
      const to = filter.to ? new Date(`${filter.to.slice(0, 10)}T23:59:59.999Z`) : undefined;
      if ((from && Number.isNaN(+from)) || (to && Number.isNaN(+to))) {
        throw new BadRequestException('Invalid from/to date');
      }
      if (from && to && from > to) {
        throw new BadRequestException('Invalid from/to date: from is after to');
      }
      where.occurredAt = { gte: from, lte: to };
    }

    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take: filter.take,
        skip: filter.skip,
      }),
    ]);

    // AuditLog deliberately has no User relation (the trail outlives users),
    // so resolve actor display names in one batch here.
    const actorIds = [...new Set(logs.map((l) => l.actorId).filter((a): a is string => !!a))];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, nameAr: true, nameEn: true, email: true },
        })
      : [];
    const byId = new Map(actors.map((a) => [a.id, a]));

    return {
      total,
      rows: logs.map((l) => ({
        id: l.id,
        occurredAt: l.occurredAt,
        actorId: l.actorId,
        actor: l.actorId ? (byId.get(l.actorId) ?? null) : null,
        entityType: l.entityType,
        entityId: l.entityId,
        action: l.action,
        beforeJson: l.beforeJson,
        afterJson: l.afterJson,
        ip: l.ip,
      })),
    };
  }

  /** Distinct values actually present in this org's trail — feeds the filter dropdowns. */
  async auditFacets(user: AuthUser) {
    const [types, actions] = await Promise.all([
      this.prisma.auditLog.groupBy({
        by: ['entityType'],
        where: { organizationId: user.organizationId },
        orderBy: { entityType: 'asc' },
      }),
      this.prisma.auditLog.groupBy({
        by: ['action'],
        where: { organizationId: user.organizationId },
        orderBy: { action: 'asc' },
      }),
    ]);
    return {
      entityTypes: types.map((t) => t.entityType),
      actions: actions.map((a) => a.action),
    };
  }
}

interface AuditFilter {
  entityType?: string;
  entityId?: string;
  action?: string;
  actorId?: string;
  from?: string;
  to?: string;
  take: number;
  skip: number;
}
