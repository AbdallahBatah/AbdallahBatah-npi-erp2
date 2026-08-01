import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FsmService } from './fsm.service';

/**
 * FSM-02 automation: the plan/generate-due HTTP endpoint (fsm.controller)
 * still exists for an on-demand "generate now" button, but a real deployment
 * cannot rely on someone remembering to click it every day. This is the
 * unattended nightly equivalent, across every organization.
 */
@Injectable()
export class FsmScheduler {
  private readonly logger = new Logger(FsmScheduler.name);

  constructor(private readonly fsm: FsmService) {}

  @Cron('0 1 * * *', { name: 'generate-due-maintenance', timeZone: 'Asia/Riyadh' })
  async generateDueMaintenance() {
    // A cron handler that rejects becomes an unhandledRejection — nothing up
    // the stack catches it. Log and survive; tonight's failure must not take
    // the API down, and tomorrow's run picks the same due plans up again.
    try {
      const results = await this.fsm.generateDueForAllOrgs();
      const total = results.reduce((s, r) => s + r.count, 0);
      if (total > 0) {
        this.logger.log(`Generated ${total} preventive work order(s) across ${results.length} organization(s)`);
      }
    } catch (err) {
      this.logger.error(
        'Nightly preventive-maintenance generation failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
