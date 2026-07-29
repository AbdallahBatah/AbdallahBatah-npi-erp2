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

  async login(dto: LoginDto, ip?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: { role: true, organization: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
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
