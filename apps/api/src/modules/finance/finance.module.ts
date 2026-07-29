import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ZatcaService } from './zatca.service';

@Module({
  // ReportsController first: its 'finance/reports/*' paths must not be
  // swallowed by InvoicesController's parameterised 'finance/...' routes.
  controllers: [ReportsController, InvoicesController],
  providers: [InvoicesService, ReportsService, ZatcaService],
})
export class FinanceModule {}
