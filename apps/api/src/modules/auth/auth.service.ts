import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { LoginDto } from './dto';

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
      include: { role: true, organization: true },
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
        permissions: user.role.permissions,
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
      include: { role: true, organization: true },
    });
    return {
      id: user.id,
      email: user.email,
      nameAr: user.nameAr,
      nameEn: user.nameEn,
      locale: user.locale,
      roleKey: user.role.key,
      permissions: user.role.permissions,
      organization: {
        id: user.organization.id,
        nameAr: user.organization.legalNameAr,
        nameEn: user.organization.legalNameEn,
        baseCurrency: user.organization.baseCurrency,
      },
    };
  }
}
