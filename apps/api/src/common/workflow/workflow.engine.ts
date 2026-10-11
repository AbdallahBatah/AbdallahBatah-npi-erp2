import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit.service';
import { OutboxService } from './outbox.service';
import { evaluateCondition, type ConditionContext } from './condition';
import { WF_ACTIONS_REQUIRING_COMMENT, WF_FLOW_META_BY_DOCUMENT, WF_SYSTEM_ACTIONS } from '@npi/shared';
import type { AuthUser } from '../auth-user';
import type { Prisma } from '@npi/db';

/**
 * What the owning module does to its own row while the engine holds the
 * transaction open. The engine never touches a business table itself — that is
 * what keeps `wf_*` a kernel concern and not a module that knows about
 * purchase orders.
 */
export type TransitionApply = (
  tx: Prisma.TransactionClient,
  ctx: { fromState: string; toState: string; actionCode: string },
) => Promise<void>;

/**
 * CRM Phase 1 · Step 4. The clock, not a person: the only actor that has no user
 * behind it. It skips the permission check — there is no one to hold it — and
 * leaves `actorId` null in the history, the audit trail and the event, exactly as
 * the seed does for an `ADOPT`. It may perform ONLY the actions in
 * WF_SYSTEM_ACTIONS (today: EXPIRE); anything else it asks for is refused, so
 * "the system approved it" can never appear in the trail.
 */
export interface SystemActor {
  system: true;
  organizationId: string;
}
export type Actor = AuthUser | SystemActor;
export const isSystemActor = (actor: Actor): actor is SystemActor =>
  (actor as SystemActor).system === true;

export interface OpenInput {
  organizationId: string;
  flowCode: string;
  documentId: string;
  documentCode: string;
  /** Role that owes the first action, if any. */
  assigneeRoleId?: string | null;
}

export interface AdoptInput {
  organizationId: string;
  flowCode: string;
  documentId: string;
  documentCode: string;
  /** The flow state the document is already in. */
  stateCode: string;
}

export interface TransitionInput {
  documentType: string;
  documentId: string;
  actionCode: string;
  comment?: string | null;
  /** Facts a transition's `conditionExpr` may compare against. */
  context?: ConditionContext;
  /** Who owes the next action once the move lands. */
  assigneeRoleId?: string | null;
  /** Extra fields merged into the emitted event's payload. */
  eventPayload?: Record<string, unknown>;
  /** The module's own state change, run in the engine's transaction. */
  apply?: TransitionApply;
  /**
   * Set when the actor is signing through a delegation — recorded on the
   * history row so the trail says whose authority was used.
   */
  onBehalfOfRoleId?: string | null;
}

export interface TransitionResult {
  instanceId: string;
  fromState: string;
  toState: string;
  actionCode: string;
  closed: boolean;
  eventId: string | null;
}

export interface AvailableAction {
  actionCode: string;
  nameAr: string;
  nameEn: string;
  toState: string;
  requiresApproval: boolean;
  requiresComment: boolean;
}

/**
 * The workflow engine — §4 of the approved architecture.
 *
 * The golden rule, restated as code: no module may write a document's status
 * column. It calls `transition()`, which is the only place that
 *
 *   · looks the move up in wf_transitions (an unlisted move cannot happen),
 *   · checks the actor's live permissions,
 *   · evaluates the transition's condition against caller-supplied facts,
 *   · runs the module's own state change,
 *   · appends the immutable history row, and
 *   · writes the outbox event —
 *
 * all inside one transaction. Any of those failing rolls back the others,
 * which is the property that makes the audit trail trustworthy: there is no
 * ordering in which a document moves without its history, or gains a history
 * row for a move that did not happen.
 */
@Injectable()
export class WorkflowEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ── opening a flow ────────────────────────────────────────────────────────

  /**
   * Put a new document at its flow's INITIAL state. Called from inside the
   * transaction that creates the document, so a document can never exist
   * without an instance — the state of a document with no instance is
   * unknowable, and every read path would need a fallback for it.
   */
  async open(tx: Prisma.TransactionClient, input: OpenInput): Promise<{ id: string; state: string }> {
    const definition = await this.activeDefinition(tx, input.organizationId, input.flowCode);
    const initial = definition.states.find((s) => s.kind === 'INITIAL');
    if (!initial) {
      throw new BadRequestException(
        `Flow ${input.flowCode} has no INITIAL state — it cannot be started`,
      );
    }
    const instance = await tx.wfInstance.create({
      data: {
        organizationId: input.organizationId,
        definitionId: definition.id,
        documentType: definition.documentType,
        documentId: input.documentId,
        documentCode: input.documentCode,
        currentState: initial.code,
        assigneeRoleId: input.assigneeRoleId ?? null,
      },
      select: { id: true, currentState: true },
    });
    await tx.wfHistory.create({
      data: {
        instanceId: instance.id,
        fromState: initial.code,
        toState: initial.code,
        actionCode: 'OPEN',
        actorId: null,
        comment: null,
      },
    });
    return { id: instance.id, state: instance.currentState };
  }

  /**
   * Take a document that already exists into its flow at the state it is already in
   * — the kernel version of what the seed does for documents older than the engine.
   * The history row says ADOPT and names no actor: nobody performed that move, and
   * attributing it to whoever happened to trigger it would be a false entry in an
   * append-only trail. A document already in a FINAL state is adopted closed, so it
   * never sits in a task box. Idempotent: a document that already has an instance
   * keeps it.
   */
  async adopt(tx: Prisma.TransactionClient, input: AdoptInput): Promise<{ id: string; state: string }> {
    const definition = await this.activeDefinition(tx, input.organizationId, input.flowCode);
    const existing = await tx.wfInstance.findFirst({
      where: {
        organizationId: input.organizationId,
        documentType: definition.documentType,
        documentId: input.documentId,
      },
      select: { id: true, currentState: true },
    });
    if (existing) return { id: existing.id, state: existing.currentState };

    const state = definition.states.find((st) => st.code === input.stateCode);
    if (!state) {
      throw new BadRequestException(
        `Flow ${input.flowCode} has no state "${input.stateCode}" to adopt ${input.documentCode} into`,
      );
    }
    const instance = await tx.wfInstance.create({
      data: {
        organizationId: input.organizationId,
        definitionId: definition.id,
        documentType: definition.documentType,
        documentId: input.documentId,
        documentCode: input.documentCode,
        currentState: state.code,
        assigneeRoleId: null,
        closedAt: state.kind === 'FINAL' ? new Date() : null,
      },
      select: { id: true, currentState: true },
    });
    await tx.wfHistory.create({
      data: {
        instanceId: instance.id,
        fromState: state.code,
        toState: state.code,
        actionCode: 'ADOPT',
        actorId: null,
        comment: 'Adopted into the workflow engine',
      },
    });
    return { id: instance.id, state: instance.currentState };
  }

  // ── the single entry point for every state change ─────────────────────────

  /**
   * Refuses before it mutates, and mutates atomically. The order of the checks
   * is deliberate: legality of the move first, then authority, then business
   * condition — so an actor without permission is told they lack permission,
   * not that the amount is wrong, and cannot use the error message to probe
   * document values they are not allowed to read.
   */
  async transition(user: Actor, input: TransitionInput): Promise<TransitionResult> {
    const plan = await this.plan(user, input);
    // The system acts without a person: nothing to record as the actor.
    const actorId = isSystemActor(user) ? null : user.userId;

    return this.prisma.$transaction(async (tx) => {
      // Re-read inside the transaction and refuse if the document moved while
      // we were deciding. Without this, two approvers clicking at the same
      // moment both pass the checks above and both apply.
      const fresh = await tx.wfInstance.findUnique({
        where: { id: plan.instance.id },
        select: { currentState: true, closedAt: true },
      });
      if (!fresh || fresh.currentState !== plan.fromState || fresh.closedAt !== null) {
        throw new BadRequestException(
          `${plan.instance.documentCode} moved while this action was in flight — reload and try again`,
        );
      }

      if (input.apply) {
        await input.apply(tx, {
          fromState: plan.fromState,
          toState: plan.toState,
          actionCode: plan.transition.actionCode,
        });
      }

      const closing = plan.toStateKind === 'FINAL';
      await tx.wfInstance.update({
        where: { id: plan.instance.id },
        data: {
          currentState: plan.toState,
          assigneeRoleId: closing ? null : (input.assigneeRoleId ?? null),
          closedAt: closing ? new Date() : null,
        },
      });

      await tx.wfHistory.create({
        data: {
          instanceId: plan.instance.id,
          fromState: plan.fromState,
          toState: plan.toState,
          actionCode: plan.transition.actionCode,
          actorId,
          onBehalfOfRoleId: input.onBehalfOfRoleId ?? null,
          comment: input.comment?.trim() || null,
        },
      });

      let eventId: string | null = null;
      if (plan.transition.emitsEvent) {
        eventId = await this.outbox.emit(tx, {
          organizationId: user.organizationId,
          eventCode: plan.transition.emitsEvent,
          payload: {
            ...(input.eventPayload ?? {}),
            documentType: plan.instance.documentType,
            documentId: plan.instance.documentId,
            documentCode: plan.instance.documentCode,
            fromState: plan.fromState,
            toState: plan.toState,
            actorId,
          },
        });
      }

      await this.audit.record(
        {
          organizationId: user.organizationId,
          actorId,
          entityType: plan.instance.documentType,
          entityId: plan.instance.documentId,
          action: plan.transition.actionCode,
          before: { state: plan.fromState },
          after: { state: plan.toState, comment: input.comment?.trim() || null },
        },
        tx,
      );

      return {
        instanceId: plan.instance.id,
        fromState: plan.fromState,
        toState: plan.toState,
        actionCode: plan.transition.actionCode,
        closed: closing,
        eventId,
      };
    });
  }

  /**
   * Everything `transition` checks, without mutating anything.
   *
   * Exists because of the approval matrix: a gated action must be validated
   * *before* a signature chain is opened, or a chain can be raised for a move
   * that would have been refused — leaving people to sign something that can
   * never be applied.
   */
  async assertCan(user: Actor, input: TransitionInput): Promise<{ toState: string }> {
    const plan = await this.plan(user, input);
    return { toState: plan.toState };
  }

  private async plan(user: Actor, input: TransitionInput) {
    const instance = await this.prisma.wfInstance.findFirst({
      where: {
        organizationId: user.organizationId,
        documentType: input.documentType,
        documentId: input.documentId,
        closedAt: null,
      },
      include: { definition: { include: { states: true } } },
    });
    if (!instance) {
      throw new NotFoundException(
        `No open workflow for ${input.documentType} ${input.documentId}`,
      );
    }

    const transition = await this.prisma.wfTransition.findUnique({
      where: {
        definitionId_fromState_actionCode: {
          definitionId: instance.definitionId,
          fromState: instance.currentState,
          actionCode: input.actionCode,
        },
      },
    });
    if (!transition) {
      const stateName =
        instance.definition.states.find((s) => s.code === instance.currentState)?.nameEn ??
        instance.currentState;
      throw new BadRequestException(
        `"${input.actionCode}" is not a legal action on ${instance.documentCode} while it is ${stateName}`,
      );
    }

    if (isSystemActor(user)) {
      // No permission to check, so the guard is the list of what the system may do.
      if (!WF_SYSTEM_ACTIONS.includes(transition.actionCode)) {
        throw new ForbiddenException('Insufficient permissions');
      }
    } else if (!user.permissions.includes(transition.requiredPermission)) {
      // Generic on purpose, matching PermissionsGuard: do not enumerate the
      // permission model to a caller who does not hold it.
      throw new ForbiddenException('Insufficient permissions');
    }

    if (
      WF_ACTIONS_REQUIRING_COMMENT.includes(transition.actionCode) &&
      !input.comment?.trim()
    ) {
      throw new BadRequestException(
        `"${transition.nameEn}" requires a reason — say why, so the person who raised this knows what to fix`,
      );
    }

    if (!evaluateCondition(transition.conditionExpr, input.context ?? {})) {
      throw new BadRequestException(
        `${instance.documentCode} does not meet the condition for "${transition.nameEn}"`,
      );
    }

    const toState = instance.definition.states.find((s) => s.code === transition.toState);
    if (!toState) {
      // The composite foreign key makes this unreachable through migrations;
      // it is here so a hand-edited database fails loudly instead of writing a
      // state nothing can render.
      throw new BadRequestException(
        `Flow ${instance.definition.code} has no state "${transition.toState}"`,
      );
    }

    return {
      instance,
      transition,
      fromState: instance.currentState,
      toState: transition.toState,
      toStateKind: toState.kind,
    };
  }

  // ── reading ───────────────────────────────────────────────────────────────

  /** What this user may do to this document right now — drives the buttons. */
  async available(
    user: AuthUser,
    documentType: string,
    documentId: string,
    context: ConditionContext = {},
  ): Promise<AvailableAction[]> {
    const instance = await this.prisma.wfInstance.findFirst({
      where: {
        organizationId: user.organizationId,
        documentType,
        documentId,
        closedAt: null,
      },
      select: { definitionId: true, currentState: true },
    });
    if (!instance) return [];

    const transitions = await this.prisma.wfTransition.findMany({
      where: { definitionId: instance.definitionId, fromState: instance.currentState },
      orderBy: { sortOrder: 'asc' },
    });
    return transitions
      .filter((t) => user.permissions.includes(t.requiredPermission))
      .filter((t) => evaluateCondition(t.conditionExpr, context))
      .map((t) => ({
        actionCode: t.actionCode,
        nameAr: t.nameAr,
        nameEn: t.nameEn,
        toState: t.toState,
        requiresApproval: t.requiresApproval,
        requiresComment: WF_ACTIONS_REQUIRING_COMMENT.includes(t.actionCode),
      }));
  }

  instanceFor(organizationId: string, documentType: string, documentId: string) {
    return this.prisma.wfInstance.findFirst({
      where: { organizationId, documentType, documentId },
      include: {
        state: { select: { code: true, nameAr: true, nameEn: true, kind: true } },
        assigneeRole: { select: { id: true, key: true, nameAr: true, nameEn: true } },
      },
      orderBy: { openedAt: 'desc' },
    });
  }

  /** The document's own trail: who moved it, when, and what they said. */
  async history(organizationId: string, documentType: string, documentId: string) {
    const instance = await this.prisma.wfInstance.findFirst({
      where: { organizationId, documentType, documentId },
      orderBy: { openedAt: 'desc' },
      select: { id: true, definitionId: true },
    });
    if (!instance) return [];

    const [rows, states] = await Promise.all([
      this.prisma.wfHistory.findMany({
        where: { instanceId: instance.id },
        orderBy: { createdAt: 'asc' },
        include: { actor: { select: { id: true, nameAr: true, nameEn: true } } },
      }),
      this.prisma.wfState.findMany({
        where: { definitionId: instance.definitionId },
        select: { code: true, nameAr: true, nameEn: true },
      }),
    ]);
    const label = new Map(states.map((s) => [s.code, s]));
    return rows.map((r) => ({
      ...r,
      fromStateName: label.get(r.fromState) ?? null,
      toStateName: label.get(r.toState) ?? null,
    }));
  }

  /**
   * The workflow half of the unified task box: every open document parked on
   * this user's role. Role-scoped, not user-scoped — see the note on
   * WfInstance.assigneeRoleId.
   */
  async tasksFor(user: AuthUser) {
    const rows = await this.prisma.wfInstance.findMany({
      where: {
        organizationId: user.organizationId,
        assigneeRoleId: user.roleId,
        closedAt: null,
      },
      include: {
        state: { select: { code: true, nameAr: true, nameEn: true } },
        definition: { select: { code: true, nameAr: true, nameEn: true } },
      },
      orderBy: { openedAt: 'asc' },
    });
    return rows.map((r) => {
      const meta = WF_FLOW_META_BY_DOCUMENT[r.documentType];
      return {
        instanceId: r.id,
        documentType: r.documentType,
        documentId: r.documentId,
        documentCode: r.documentCode,
        flowCode: r.definition.code,
        flowNameAr: r.definition.nameAr,
        flowNameEn: r.definition.nameEn,
        stateCode: r.state.code,
        stateNameAr: r.state.nameAr,
        stateNameEn: r.state.nameEn,
        openedAt: r.openedAt,
        linkPath: meta ? meta.linkPattern.replace(':id', r.documentId) : null,
      };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async activeDefinition(
    tx: Prisma.TransactionClient,
    organizationId: string,
    flowCode: string,
  ) {
    const definition = await tx.wfDefinition.findFirst({
      where: { organizationId, code: flowCode, isActive: true },
      include: { states: true },
      orderBy: { version: 'desc' },
    });
    if (!definition) {
      throw new BadRequestException(
        `No active workflow definition "${flowCode}" for this organization — run the seed`,
      );
    }
    return definition;
  }
}
