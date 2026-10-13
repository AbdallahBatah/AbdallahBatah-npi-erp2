import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@npi/db';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import {
  EFFECTIVE_PERMISSIONS_INCLUDE,
  resolveEffectivePermissions,
} from '../../common/effective-permissions.service';
import { ChangePasswordDto, LoginDto } from './dto';

/**
 * The user plus everything their effective permissions are made of — the
 * loader's own include, read here in the same query as the organization and
 * the password hash rather than in a second one.
 */
const USER_INCLUDE = {
  ...EFFECTIVE_PERMISSIONS_INCLUDE,
  organization: true,
} as const;

type UserWithRoles = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

/**
 * Primary role first, then extras. Permissions are the effective set — the
 * evaluation JwtStrategy runs on every request, so the web app and Madar read
 * the same list the guard enforces.
 */
function describeRoles(user: UserWithRoles) {
  const { roles, permissions } = resolveEffectivePermissions(user);
  return {
    roles: roles.map((r) => ({ id: r.id, key: r.key, nameAr: r.nameAr, nameEn: r.nameEn })),
    permissions,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Burned once at module load so the unknown-email path costs the same bcrypt
   * work as a real comparison — no timing oracle for user enumeration.
   */
  private static readonly DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

  async login(dto: LoginDto, ip?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: USER_INCLUDE,
    });

    if (!user || !user.isActive) {
      await bcrypt.compare(dto.password, AuthService.DUMMY_HASH);
      if (user) {
        await this.recordFailedLogin(user.organizationId, user.id, ip);
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      await this.recordFailedLogin(user.organizationId, user.id, ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    const token = await this.jwt.signAsync({
      sub: user.id,
      org: user.organizationId,
    });

    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.id,
      entityType: 'User',
      entityId: user.id,
      action: 'LOGIN',
      ip,
    });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        nameAr: user.nameAr,
        nameEn: user.nameEn,
        locale: user.locale,
        roleKey: user.role.key,
        roleNameAr: user.role.nameAr,
        roleNameEn: user.role.nameEn,
        ...describeRoles(user),
        organization: {
          id: user.organization.id,
          nameAr: user.organization.legalNameAr,
          nameEn: user.organization.legalNameEn,
          baseCurrency: user.organization.baseCurrency,
        },
      },
    };
  }

  private async recordFailedLogin(
    organizationId: string,
    userId: string,
    ip?: string,
  ) {
    // Best-effort: an audit hiccup must never mask the 401 itself.
    try {
      await this.audit.record({
        organizationId,
        actorId: userId,
        entityType: 'User',
        entityId: userId,
        action: 'LOGIN_FAILED',
        ip,
      });
    } catch {
      /* ignore */
    }
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: USER_INCLUDE,
    });
    return {
      id: user.id,
      email: user.email,
      nameAr: user.nameAr,
      nameEn: user.nameEn,
      locale: user.locale,
      roleKey: user.role.key,
      roleNameAr: user.role.nameAr,
      roleNameEn: user.role.nameEn,
      ...describeRoles(user),
      organization: {
        id: user.organization.id,
        nameAr: user.organization.legalNameAr,
        nameEn: user.organization.legalNameEn,
        baseCurrency: user.organization.baseCurrency,
      },
    };
  }

  /** Self-service password change — requires proving the current password. */
  async changePassword(userId: string, dto: ChangePasswordDto, ip?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('Current password is incorrect');
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must differ from the current one');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 10) },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: userId,
      entityType: 'User',
      entityId: userId,
      action: 'PASSWORD_CHANGE',
      ip,
    });
    return { ok: true };
  }
}
