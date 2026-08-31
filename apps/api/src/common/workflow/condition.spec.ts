import {
  ConditionSyntaxError,
  conditionFields,
  evaluateCondition,
  parseCondition,
} from './condition';

/**
 * `conditionExpr` is a row an administrator can edit. The tests that matter
 * most here are therefore not "does it compute" but "can a hostile or careless
 * value in that column do anything other than be false".
 */
describe('workflow transition conditions', () => {
  describe('the safety property', () => {
    it('never executes what it reads — code in the column is a parse error', () => {
      for (const attack of [
        'process.exit(1)',
        'total > 0; require("fs").rmSync("/")',
        'constructor.constructor("return 1")()',
        '__proto__ == 1',
        'this.total > 0',
      ]) {
        expect(() => parseCondition(attack)).toThrow(ConditionSyntaxError);
      }
    });

    it('reads only the flat context it is handed, never a nested path', () => {
      // `a.b` is not a valid identifier, so traversal cannot even be expressed.
      expect(() => parseCondition('vendor.name == "x"')).toThrow(ConditionSyntaxError);
    });

    it('refuses "or" rather than half-supporting it', () => {
      // Silently ignoring `||` would make a two-branch rule quietly become a
      // one-branch rule — the worst possible failure for an approval gate.
      expect(() => parseCondition('total > 1 || total < 0')).toThrow(/Only "&&"/);
    });
  });

  describe('evaluation', () => {
    it('treats an absent expression as "no condition", not "never"', () => {
      expect(evaluateCondition(null, {})).toBe(true);
      expect(evaluateCondition('', {})).toBe(true);
      expect(evaluateCondition('   ', {})).toBe(true);
    });

    it('compares numbers, strings, booleans and null', () => {
      const ctx = { total: 150_000, currency: 'SAR', urgent: true, projectId: null };
      expect(evaluateCondition('total > 100000', ctx)).toBe(true);
      expect(evaluateCondition('total >= 150000', ctx)).toBe(true);
      expect(evaluateCondition('total < 100000', ctx)).toBe(false);
      expect(evaluateCondition('currency == "SAR"', ctx)).toBe(true);
      expect(evaluateCondition("currency == 'USD'", ctx)).toBe(false);
      expect(evaluateCondition('urgent == true', ctx)).toBe(true);
      expect(evaluateCondition('projectId == null', ctx)).toBe(true);
      expect(evaluateCondition('projectId != null', ctx)).toBe(false);
    });

    it('requires every clause of a conjunction', () => {
      const ctx = { total: 150_000, projectId: 'p1' };
      expect(evaluateCondition('total > 100000 && projectId != null', ctx)).toBe(true);
      expect(evaluateCondition('total > 200000 && projectId != null', ctx)).toBe(false);
    });

    it('treats a missing field as null rather than throwing', () => {
      // A flow that references a fact the caller did not supply must fail the
      // condition — refusing the move — not 500 the request.
      expect(evaluateCondition('matchResult == "MATCHED"', {})).toBe(false);
      expect(evaluateCondition('matchResult == null', {})).toBe(true);
    });

    it('refuses to order-compare non-numbers instead of coercing them', () => {
      // `"" > 0` is false and `"" >= 0` is true in JavaScript. An approval gate
      // built on that is a gate that opens for reasons nobody can explain.
      expect(evaluateCondition('total > 0', { total: '' as never })).toBe(false);
      expect(evaluateCondition('total >= 0', { total: '' as never })).toBe(false);
      expect(evaluateCondition('total > 0', { total: undefined })).toBe(false);
    });

    it('is exact on the boundary the bands depend on', () => {
      expect(evaluateCondition('total > 100000', { total: 100_000 })).toBe(false);
      expect(evaluateCondition('total >= 100000', { total: 100_000 })).toBe(true);
    });
  });

  it('reports the fields an expression reads, for validating a flow', () => {
    expect(conditionFields('total > 1 && projectId != null && total < 9')).toEqual([
      'total',
      'projectId',
    ]);
    expect(conditionFields(null)).toEqual([]);
  });
});
