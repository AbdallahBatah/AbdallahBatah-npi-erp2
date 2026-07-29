import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from './decorators';

/**
 * Liveness + readiness in one: proves the process is up AND the database is
 * reachable (a bare TCP check cannot tell a wedged API from a healthy one).
 * Used by the Docker healthcheck and any future uptime monitor.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check() {
    try {
      await this.prisma.organization.count();
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
    return { status: 'ok', db: 'up' };
  }
}
