import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, SkipPermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

/**
 * Personal notification feed. @SkipPermissions like /auth/me: every query is
 * hard-scoped to the caller's own userId, so there is nothing a permission
 * could further protect.
 */
@Controller('notifications')
@UseGuards(PermissionsGuard)
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @SkipPermissions()
  async list(@CurrentUser() user: AuthUser) {
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId: user.userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      this.prisma.notification.count({ where: { userId: user.userId, readAt: null } }),
    ]);
    return { rows, unreadCount };
  }

  @Get('unread-count')
  @SkipPermissions()
  async unreadCount(@CurrentUser() user: AuthUser) {
    const unreadCount = await this.prisma.notification.count({
      where: { userId: user.userId, readAt: null },
    });
    return { unreadCount };
  }

  @Post('read-all')
  @SkipPermissions()
  async readAll(@CurrentUser() user: AuthUser) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId: user.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true, count };
  }

  @Post(':id/read')
  @SkipPermissions()
  async read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.notification.updateMany({
      // userId in the filter — a user can only ever mark their own rows.
      where: { id, userId: user.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
}
