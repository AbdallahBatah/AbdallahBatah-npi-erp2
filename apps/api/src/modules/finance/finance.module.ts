import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PayablesController } from './payables.controller';
import { PayablesService } from './payables.service';
import { ZatcaService } from './zatca.service';

@Module({
  // ReportsController first: its 'finance/reports/*' paths must not be
  // swallowed by InvoicesController's parameterised 'finance/...' routes.
  // PayablesController ('finance/payables/*') is fixed-prefix for the same reason.
  controllers: [ReportsController, PayablesController, InvoicesController],
  providers: [InvoicesService, ReportsService, PayablesService, ZatcaService],
})
export class FinanceModule {}
