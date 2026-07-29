import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { KernelModule } from './common/kernel.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
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

@Module({
  imports: [
    // Load the shared root .env (the monorepo keeps one env file at the root).
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
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
  ],
  providers: [
    // Global authentication: every route requires a JWT unless @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
