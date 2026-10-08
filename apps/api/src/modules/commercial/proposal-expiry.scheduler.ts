import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { riyadhDayStart } from '@npi/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ProposalsService } from './proposals.service';

/**
 * CRM Phase 1 · Step 4 (spec 4.3): «مدة الصلاحية إلزامية، وينتقل العرض تلقائياً إلى
 * منتهي الصلاحية بعدها».
 *
 * Every night (01:30 Riyadh time) each revision that is approved or sent and whose
 * valid-until DAY ended before today began is moved to EXPIRED — by the workflow
 * engine, as the system actor (no person), so the history says who did it: nobody.
 * A draft is not swept (its date is still being worked out) and neither is a
 * revision awaiting approval (the approver is told, on approval, if it ran out —
 * see ProposalsService.applyApproval). The valid-until day itself is still valid.
 *
 * The sweep only SELECTS; the move, its rules and the author's notification live in
 * ProposalsService.expireBySystem, which the send path uses too.
 */
@Injectable()
export class ProposalExpiryScheduler {
  private readonly logger = new Logger(ProposalExpiryScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proposals: ProposalsService,
  ) {}

  @Cron('30 1 * * *', { name: 'expire-proposal-revisions', timeZone: 'Asia/Riyadh' })
  async scheduledSweep(): Promise<void> {
    try {
      const expired = await this.sweep();
      if (expired > 0) this.logger.warn(`Expired ${expired} proposal revision(s) whose validity ended`);
    } catch (err) {
      // Never let a cron rejection become an unhandledRejection and take the API
      // down; tomorrow night's run sees the same revisions.
      this.logger.error('Proposal expiry sweep failed', err instanceof Error ? err.stack : String(err));
    }
  }

  /** Returns how many revisions were expired. Callable directly from a test. */
  async sweep(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.proposalRevision.findMany({
      where: {
        status: { in: ['APPROVED', 'SENT'] },
        // The valid-until day is stored as UTC midnight of its Riyadh date; it is
        // over once today (Riyadh) has begun after it.
        validUntil: { lt: riyadhDayStart(now) },
      },
      select: { id: true, proposalId: true, proposal: { select: { organizationId: true } } },
    });

    let count = 0;
    for (const row of due) {
      try {
        if (await this.proposals.expireBySystem(row.proposal.organizationId, row.proposalId, now)) count += 1;
      } catch (err) {
        // One proposal that cannot move must not keep the others from expiring.
        this.logger.error(
          `Could not expire proposal ${row.proposalId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
    return count;
  }
}
