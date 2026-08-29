import { Global, Module } from '@nestjs/common';
import { NumberingService } from './numbering.service';
import { AuditService } from './audit.service';
import { PostingService } from './posting.service';
import { TaxService } from './tax.service';
import { NotificationService } from './notification.service';
import { ApprovalService } from './approval.service';
import { ApprovalEscalationScheduler } from './approval-escalation.scheduler';
import { DelegationService } from './delegation.service';
import { WorkflowEngine } from './workflow/workflow.engine';
import { OutboxService } from './workflow/outbox.service';
import { EventDispatcher } from './workflow/event-dispatcher.service';

/**
 * Shared kernel services (numbering, audit, posting rules, tax, approvals,
 * and — since M4 — the workflow engine and its outbox) available to every
 * business module without re-importing: the in-process "shared kernel" from
 * the spec. The approval matrix lives here rather than in a feature module so
 * procurement, projects and finance can all gate on it without any of them
 * depending on each other; the engine lives here for exactly the same reason,
 * and the dependency runs one way only — modules import the kernel, never the
 * reverse. That is what lets a module be lifted out later.
 */
@Global()
@Module({
  providers: [
    NumberingService,
    AuditService,
    PostingService,
    TaxService,
    NotificationService,
    ApprovalService,
    DelegationService,
    ApprovalEscalationScheduler,
    OutboxService,
    WorkflowEngine,
    EventDispatcher,
  ],
  exports: [
    NumberingService,
    AuditService,
    PostingService,
    TaxService,
    NotificationService,
    ApprovalService,
    DelegationService,
    OutboxService,
    WorkflowEngine,
    EventDispatcher,
  ],
})
export class KernelModule {}
