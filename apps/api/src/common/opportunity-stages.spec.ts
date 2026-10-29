/**
 * CRM Phase 1 · Step 3 — the opportunity stage rules (contract §2, §7).
 *
 * `packages/shared` has no jest setup of its own, so this spec lives with the
 * API (the same arrangement as arabic.spec.ts) and imports the functions
 * through the package entry point exactly as the services do.
 */
import {
  OPPORTUNITY_STAGES,
  OPPORTUNITY_STAGE_FLOW,
  OPPORTUNITY_TERMINAL,
  OPPORTUNITY_TYPES,
  isBackwardMove,
  isOpenStage,
  opportunityTransition,
  WF_EVENTS,
  WF_EVENT_LABELS,
} from '@npi/shared';

const OPEN = ['PROSPECTING', 'COST_STUDY', 'PROPOSAL', 'NEGOTIATION'] as const;

describe('the stage vocabulary', () => {
  it('lists the six stages in funnel order with the document\'s Arabic names', () => {
    expect(OPPORTUNITY_STAGES.map((s) => s.value)).toEqual([
      'PROSPECTING', 'COST_STUDY', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST',
    ]);
    expect(OPPORTUNITY_STAGES.map((s) => s.labelAr)).toEqual([
      'محتمل', 'تأهيل', 'عرض سعر', 'تفاوض', 'رابحة', 'خاسرة',
    ]);
  });

  it('exposes the open flow and the terminal stages', () => {
    expect([...OPPORTUNITY_STAGE_FLOW]).toEqual([...OPEN]);
    expect([...OPPORTUNITY_TERMINAL]).toEqual(['WON', 'LOST']);
  });

  it('has the two opportunity types, direct and tender', () => {
    expect(OPPORTUNITY_TYPES.map((t) => t.value)).toEqual(['DIRECT', 'TENDER']);
    expect(OPPORTUNITY_TYPES.map((t) => t.labelAr)).toEqual(['مباشرة', 'مناقصة']);
  });

  it('isOpenStage is true for the four open stages only', () => {
    for (const s of OPEN) expect(isOpenStage(s)).toBe(true);
    expect(isOpenStage('WON')).toBe(false);
    expect(isOpenStage('LOST')).toBe(false);
    expect(isOpenStage('NOPE')).toBe(false);
  });

  it('declares the two outbox events with labels', () => {
    expect(WF_EVENTS.OPPORTUNITY_WON).toBe('opportunity.won');
    expect(WF_EVENTS.OPPORTUNITY_LOST).toBe('opportunity.lost');
    expect(WF_EVENT_LABELS['opportunity.won'].ar).toBeTruthy();
    expect(WF_EVENT_LABELS['opportunity.lost'].ar).toBeTruthy();
  });
});

describe('opportunityTransition', () => {
  it('allows the next stage, one step at a time', () => {
    expect(opportunityTransition('PROSPECTING', 'COST_STUDY')).toEqual({ ok: true });
    expect(opportunityTransition('COST_STUDY', 'PROPOSAL')).toEqual({ ok: true });
    expect(opportunityTransition('PROPOSAL', 'NEGOTIATION')).toEqual({ ok: true });
  });

  it('refuses to jump forward over a stage (SKIP)', () => {
    expect(opportunityTransition('PROSPECTING', 'PROPOSAL')).toEqual({ ok: false, reason: 'SKIP' });
    expect(opportunityTransition('PROSPECTING', 'NEGOTIATION')).toEqual({ ok: false, reason: 'SKIP' });
    expect(opportunityTransition('COST_STUDY', 'NEGOTIATION')).toEqual({ ok: false, reason: 'SKIP' });
  });

  it('allows going back to any earlier open stage', () => {
    expect(opportunityTransition('COST_STUDY', 'PROSPECTING')).toEqual({ ok: true });
    expect(opportunityTransition('PROPOSAL', 'COST_STUDY')).toEqual({ ok: true });
    expect(opportunityTransition('NEGOTIATION', 'PROPOSAL')).toEqual({ ok: true });
    expect(opportunityTransition('NEGOTIATION', 'PROSPECTING')).toEqual({ ok: true });
  });

  it('tells a backward move from a forward one', () => {
    expect(isBackwardMove('NEGOTIATION', 'PROPOSAL')).toBe(true);
    expect(isBackwardMove('PROPOSAL', 'PROSPECTING')).toBe(true);
    expect(isBackwardMove('PROSPECTING', 'COST_STUDY')).toBe(false);
    expect(isBackwardMove('COST_STUDY', 'LOST')).toBe(false);
    expect(isBackwardMove('NEGOTIATION', 'WON')).toBe(false);
  });

  it.each(OPEN)('allows LOST from %s', (from) => {
    expect(opportunityTransition(from, 'LOST')).toEqual({ ok: true });
  });

  it('allows WON by hand from NEGOTIATION only', () => {
    expect(opportunityTransition('NEGOTIATION', 'WON')).toEqual({ ok: true });
    for (const from of ['PROSPECTING', 'COST_STUDY', 'PROPOSAL'] as const) {
      expect(opportunityTransition(from, 'WON')).toEqual({ ok: false, reason: 'SKIP' });
    }
  });

  it.each(['WON', 'LOST'] as const)('never leaves %s (TERMINAL) — reopening means a new opportunity', (from) => {
    for (const to of [...OPEN, 'WON', 'LOST']) {
      expect(opportunityTransition(from, to)).toEqual({ ok: false, reason: 'TERMINAL' });
    }
  });

  it('refuses a move to the stage the opportunity is already in', () => {
    for (const s of OPEN) expect(opportunityTransition(s, s).ok).toBe(false);
  });

  it('refuses a stage it does not know (UNKNOWN)', () => {
    expect(opportunityTransition('PROSPECTING', 'DREAMING')).toEqual({ ok: false, reason: 'UNKNOWN' });
    expect(opportunityTransition('DREAMING', 'PROPOSAL')).toEqual({ ok: false, reason: 'UNKNOWN' });
  });
});
