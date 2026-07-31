import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { KernelModule } from './common/kernel.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { HealthController } from './common/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { CrmModule } from './modules/crm/crm.module';
import { CommercialModule } from './modules/commercial/commercial.module';
import { FinanceModule } from './modules/finance/finance.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ProcurementModule } from './modules/procurement/procurement.module';
import { FsmModule } from './modules/fsm/fsm.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';
import { PpaModule } from './modules/ppa/ppa.module';
import { ReferenceModule } from './modules/reference/reference.module';
import { PlatformModule } from './modules/platform/platform.module';
import { AdminModule } from './modules/admin/admin.module';
import { SearchModule } from './modules/search/search.module';

@Module({
  imports: [
    // Load the shared root .env (the monorepo keeps one env file at the root).
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    // Global rate limit: 300 requests/min per IP. /auth/login is tightened
    // further with its own @Throttle() in AuthController.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    KernelModule,
    AuthModule,
    CrmModule,
    CommercialModule,
    FinanceModule,
    ProjectsModule,
    ProcurementModule,
    FsmModule,
    TelemetryModule,
    PpaModule,
    ReferenceModule,
    PlatformModule,
    AdminModule,
    SearchModule,
  ],
  controllers: [HealthController],
  providers: [
    // Guard order matters: rate limit first (also covers @Public routes),
    // then authentication, then fail-closed authorization.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global authentication: every route requires a JWT unless @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global authorization: every route must declare @RequirePermissions or
    // @SkipPermissions — undeclared routes are denied.
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Normalizes Prisma/unknown errors into stable HTTP responses.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
