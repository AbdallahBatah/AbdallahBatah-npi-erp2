import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PayablesController } from './payables.controller';
import { PayablesService } from './payables.service';
import { FiscalController } from './fiscal.controller';
import { FiscalService } from './fiscal.service';
import { ZatcaService } from './zatca.service';
import { CashFlowService } from './cash-flow.service';

@Module({
  // Fixed-prefix controllers first: their 'finance/reports/*',
  // 'finance/payables/*' and 'finance/fiscal/*' paths must not be swallowed by
  // InvoicesController's parameterised 'finance/...' routes.
  controllers: [ReportsController, PayablesController, FiscalController, InvoicesController],
  providers: [InvoicesService, ReportsService, PayablesService, FiscalService, ZatcaService, CashFlowService],
})
export class FinanceModule {}
