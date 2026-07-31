import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
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
} as const;

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

  listUsers(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { organizationId: user.organizationId },
      select: USER_SELECT,
      orderBy: { createdAt: 'asc' },
    });
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
      },
      select: USER_SELECT,
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'User',
      entityId: created.id,
      action: 'CREATE',
      after: { email, nameAr, roleId: dto.roleId },
    });
    return created;
  }

  async updateUser(user: AuthUser, id: string, dto: UpdateUserDto) {
    const target = await this.prisma.user.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { role: true },
    });
    if (!target) throw new NotFoundException('User not found');

    if (dto.isActive === false && id === user.userId) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    if (dto.roleId && dto.roleId !== target.roleId) {
      await this.getRoleOwned(user.organizationId, dto.roleId);
    }

    // Lockout guard: would this update strip the org's last active user-manager?
    const losesManage =
      target.role.permissions.includes(PERMISSIONS.USER_MANAGE) &&
      (dto.isActive === false ||
        (dto.roleId &&
          dto.roleId !== target.roleId &&
          !(await this.getRoleOwned(user.organizationId, dto.roleId)).permissions.includes(
            PERMISSIONS.USER_MANAGE,
          )));
    if (losesManage) await this.assertAnotherManagerExists(user.organizationId, target.id);

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        nameAr: dto.nameAr?.trim() || undefined,
        nameEn: dto.nameEn?.trim() || undefined,
        roleId: dto.roleId,
        isActive: dto.isActive,
        locale: dto.locale,
      },
      select: USER_SELECT,
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'User',
      entityId: id,
      action: 'UPDATE',
      before: { roleId: target.roleId, isActive: target.isActive, nameAr: target.nameAr },
      after: dto as unknown as Record<string, unknown>,
    });
    return updated;
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
        role: { permissions: { has: PERMISSIONS.USER_MANAGE } },
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
            roleId: { not: role.id },
            role: { permissions: { has: PERMISSIONS.USER_MANAGE } },
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
    const assigned = await this.prisma.user.count({ where: { roleId: id } });
    if (assigned > 0) {
      throw new BadRequestException('Role still has users assigned — reassign them first');
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
}
