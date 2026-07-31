import { isValidStageTransition, PROJECT_STAGE_FLOW } from '@npi/shared';

/**
 * The project lifecycle guard. This existed only in the web app until the API
 * started enforcing it, which meant a direct call could close a project that
 * had never been procured or executed. These cases pin the rule down so it
 * cannot quietly loosen again.
 */
describe('isValidStageTransition', () => {
  it('allows each step of the lifecycle in order', () => {
    for (let i = 0; i < PROJECT_STAGE_FLOW.length - 1; i++) {
      expect(isValidStageTransition(PROJECT_STAGE_FLOW[i], PROJECT_STAGE_FLOW[i + 1])).toBe(true);
    }
  });

  it('refuses to skip a stage — the case that was exploitable', () => {
    expect(isValidStageTransition('PLANNING', 'CLOSED')).toBe(false);
    expect(isValidStageTransition('PLANNING', 'EXECUTION')).toBe(false);
    expect(isValidStageTransition('PROCUREMENT', 'CLOSED')).toBe(false);
  });

  it('refuses to move backwards', () => {
    expect(isValidStageTransition('CLOSED', 'COMMISSIONING')).toBe(false);
    expect(isValidStageTransition('EXECUTION', 'PLANNING')).toBe(false);
  });

  it('refuses a no-op and unknown stages', () => {
    expect(isValidStageTransition('EXECUTION', 'EXECUTION')).toBe(false);
    expect(isValidStageTransition('PLANNING', 'NOT_A_STAGE')).toBe(false);
    expect(isValidStageTransition('NOT_A_STAGE', 'CLOSED')).toBe(false);
  });

  it('has nothing after the final stage', () => {
    const last = PROJECT_STAGE_FLOW[PROJECT_STAGE_FLOW.length - 1];
    for (const stage of PROJECT_STAGE_FLOW) {
      expect(isValidStageTransition(last, stage)).toBe(false);
    }
  });
});
