/**
 * Test-only. Evaluates the part of Prisma's `UserWhereInput` the permission
 * predicates are built from — AND / OR / NOT, equality, `not` / `in` / `has`,
 * a to-one relation, and `some` / `none` / `every` on a to-many one — against
 * plain fixture users, so a spec can check WHO a filter selects rather than
 * only how it is spelled. Anything else throws instead of passing silently.
 */

export interface FixtureRole {
  id: string;
  permissions: string[];
}

export interface FixtureUser {
  id: string;
  organizationId: string;
  isActive: boolean;
  roleId: string;
  role: FixtureRole;
  extraRoles: Array<{ roleId: string; role: FixtureRole }>;
  permissionOverrides: Array<{ permission: string; effect: 'GRANT' | 'DENY' }>;
}

type Row = Record<string, unknown>;

const isObject = (v: unknown): v is Row =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

const LIST_OPS = new Set(['some', 'none', 'every']);
const SCALAR_OPS = new Set(['equals', 'not', 'in', 'notIn', 'has']);

function matchesScalar(value: unknown, filter: Row): boolean {
  return Object.entries(filter).every(([op, arg]) => {
    switch (op) {
      case 'equals':
        return value === arg;
      case 'not':
        return isObject(arg) ? !matchesScalar(value, arg) : value !== arg;
      case 'in':
        return (arg as unknown[]).includes(value);
      case 'notIn':
        return !(arg as unknown[]).includes(value);
      case 'has':
        return Array.isArray(value) && value.includes(arg);
      default:
        throw new Error(`user-where: unsupported scalar filter "${op}"`);
    }
  });
}

/** Does `row` satisfy `where`? */
export function matchesWhere(where: object, row: object): boolean {
  const r = row as Row;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') {
      return (Array.isArray(cond) ? cond : [cond]).every((w: object) => matchesWhere(w, r));
    }
    if (key === 'OR') return (cond as object[]).some((w) => matchesWhere(w, r));
    if (key === 'NOT') {
      return !(Array.isArray(cond) ? cond : [cond]).some((w: object) => matchesWhere(w, r));
    }
    const value = r[key];
    if (!isObject(cond)) return value === cond;
    const ops = Object.keys(cond);
    if (Array.isArray(value) && value.every(isObject) && ops.every((o) => LIST_OPS.has(o))) {
      return ops.every((op) => {
        const w = cond[op] as object;
        if (op === 'some') return value.some((item) => matchesWhere(w, item));
        if (op === 'none') return !value.some((item) => matchesWhere(w, item));
        return value.every((item) => matchesWhere(w, item));
      });
    }
    if (ops.every((o) => SCALAR_OPS.has(o))) return matchesScalar(value, cond);
    if (isObject(value)) return matchesWhere(cond, value);
    throw new Error(`user-where: cannot evaluate "${key}"`);
  });
}

/** A fixture user: one primary role, optional extra roles and overrides. */
export function fixtureUser(
  id: string,
  primary: FixtureRole,
  over: Partial<Omit<FixtureUser, 'id' | 'role' | 'roleId'>> = {},
): FixtureUser {
  return {
    id,
    organizationId: 'org1',
    isActive: true,
    roleId: primary.id,
    role: primary,
    extraRoles: [],
    permissionOverrides: [],
    ...over,
  };
}
