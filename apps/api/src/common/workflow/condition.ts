/**
 * `wf_transitions.conditionExpr` — a deliberately tiny comparison language.
 *
 * The architecture asks each transition to carry "شرط كل انتقال". The obvious
 * implementation is `eval`, or `new Function`, over a row an administrator can
 * edit. That would make the workflow table a code-execution surface reachable
 * by anyone who can configure a flow, which is a strictly worse security
 * posture than the hardcoded `if` statements this replaces.
 *
 * So: no eval, no function constructor, no property traversal. A condition is
 * a conjunction of simple comparisons against a flat, caller-supplied context:
 *
 *     total > 100000
 *     projectId != null && lineCount >= 1
 *     currency == "SAR"
 *
 * Anything else is a parse error, raised when the flow is seeded or edited —
 * not at 2am when a document will not move and nobody knows why.
 */

export type ConditionContext = Record<string, string | number | boolean | null | undefined>;

const OPERATORS = ['>=', '<=', '!=', '==', '>', '<'] as const;
type Operator = (typeof OPERATORS)[number];

// A bare identifier: letters, digits, underscore; must not start with a digit.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names that are never a business fact. Reading them would be harmless as it
 * stands — this language only ever reads, and a comparison against
 * Object.prototype is simply false — but a field list that can name the
 * prototype chain at all is one refactor away from being a real problem.
 * Refuse them at parse time instead, where the error is loud and early.
 */
const RESERVED_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

export class ConditionSyntaxError extends Error {}

interface Comparison {
  left: string;
  op: Operator;
  right: string | number | boolean | null;
}

const parseLiteral = (raw: string): string | number | boolean | null => {
  const t = raw.trim();
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  throw new ConditionSyntaxError(
    `Unrecognised value "${t}" — expected a number, a quoted string, true, false or null`,
  );
};

const parseComparison = (raw: string): Comparison => {
  const clause = raw.trim();
  if (!clause) throw new ConditionSyntaxError('Empty comparison');

  // Longest operators first, so ">=" is never read as ">" followed by "=".
  for (const op of OPERATORS) {
    const at = clause.indexOf(op);
    if (at === -1) continue;
    const left = clause.slice(0, at).trim();
    const right = clause.slice(at + op.length).trim();
    if (!IDENTIFIER.test(left)) {
      throw new ConditionSyntaxError(
        `"${left}" is not a valid field name on the left of "${op}"`,
      );
    }
    if (RESERVED_FIELDS.has(left)) {
      throw new ConditionSyntaxError(`"${left}" is not a field a condition may read`);
    }
    if (!right) throw new ConditionSyntaxError(`Missing value after "${op}"`);
    return { left, op, right: parseLiteral(right) };
  }
  throw new ConditionSyntaxError(
    `"${clause}" has no comparison operator (one of ${OPERATORS.join(', ')})`,
  );
};

/**
 * Parse and reject early. Called when a flow is seeded or a transition edited,
 * so a malformed condition is a failure at configuration time rather than a
 * document that mysteriously refuses to move.
 */
export const parseCondition = (expr: string): Comparison[] => {
  const clauses = expr.split('&&');
  if (clauses.some((c) => c.includes('||'))) {
    throw new ConditionSyntaxError(
      'Only "&&" is supported. A transition needing "or" is two transitions — ' +
        'which is also more honest, because each one then has its own audit trail.',
    );
  }
  return clauses.map(parseComparison);
};

const compare = (
  actual: string | number | boolean | null | undefined,
  op: Operator,
  expected: string | number | boolean | null,
): boolean => {
  // undefined and null are the same thing here: "the context has no such fact".
  const a = actual === undefined ? null : actual;
  switch (op) {
    case '==':
      return a === expected;
    case '!=':
      return a !== expected;
    default:
      break;
  }
  // Ordering comparisons are only meaningful between numbers. A missing or
  // non-numeric field fails the condition rather than coercing — `"" > 0`
  // being false in one direction and true in another is exactly the kind of
  // silent wrongness this language exists to avoid.
  if (typeof a !== 'number' || typeof expected !== 'number') return false;
  switch (op) {
    case '>':
      return a > expected;
    case '<':
      return a < expected;
    case '>=':
      return a >= expected;
    case '<=':
      return a <= expected;
  }
};

/**
 * True when every clause holds. An empty or absent expression is always true —
 * "no condition" must not mean "never".
 */
export const evaluateCondition = (
  expr: string | null | undefined,
  context: ConditionContext,
): boolean => {
  if (!expr || !expr.trim()) return true;
  // Own properties only: a fact the caller did not supply is absent, never
  // something inherited from the object it happens to have been built from.
  const read = (field: string) =>
    Object.prototype.hasOwnProperty.call(context, field) ? context[field] : null;
  return parseCondition(expr).every((c) => compare(read(c.left), c.op, c.right));
};

/** The fields an expression reads — used to check a flow against its context. */
export const conditionFields = (expr: string | null | undefined): string[] =>
  !expr || !expr.trim() ? [] : [...new Set(parseCondition(expr).map((c) => c.left))];
