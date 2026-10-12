/**
 * ADR-02 task 4 (P1-6): the read routes follow the view key of their screen.
 * Three keys used to open several screens each; their routes were split along
 * the screens — crm.task.read for /tasks, scm.requisition.read for
 * /requisitions, finance.report.read for /finance, finance.statement.read for
 * /statements — and the old keys keep the routes of the screen they still open.
 * Pins the decorators and runs the real guard over them: a holder of the old
 * key alone is refused on a moved route, a holder of the new key alone on a
 * route that stayed, and a role the migration extended (old + new) reaches both.
 */
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS } from '@npi/shared';
import { PERMISSIONS_KEY } from './decorators';
import { PermissionsGuard } from './guards/permissions.guard';
import { FollowUpTasksController } from '../modules/crm/follow-up-tasks.controller';
import { CustomersController } from '../modules/crm/customers.controller';
import { ActivitiesController } from '../modules/crm/activities.controller';
import { RequisitionsController } from '../modules/procurement/requisitions.controller';
import { ProcurementController } from '../modules/procurement/procurement.controller';
import { ReportsController } from '../modules/finance/reports.controller';
import { FiscalController } from '../modules/finance/fiscal.controller';
import { InvoicesController } from '../modules/finance/invoices.controller';

type Controller = { name: string; prototype: object };
type Route = readonly [Controller, string];

const keyOf = ([cls, method]: Route): string[] =>
  Reflect.getMetadata(PERMISSIONS_KEY, (cls.prototype as Record<string, object>)[method]);

const guard = new PermissionsGuard(new Reflector());
const reaches = ([cls, method]: Route, permissions: string[]): boolean => {
  const context = {
    getHandler: () => (cls.prototype as Record<string, object>)[method],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user: { permissions } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(context);
  } catch (err) {
    if (err instanceof ForbiddenException) return false;
    throw err;
  }
};

const SPLITS: ReadonlyArray<{
  old: string;
  stays: Route[];
  moved: ReadonlyArray<{ key: string; routes: Route[] }>;
}> = [
  {
    old: PERMISSIONS.CUSTOMER_READ,
    stays: [
      [CustomersController, 'list'],
      [CustomersController, 'similar'],
      [CustomersController, 'get'],
      [CustomersController, 'overview'],
      [CustomersController, 'listContacts'],
      [ActivitiesController, 'list'],
    ],
    moved: [
      {
        key: PERMISSIONS.TASK_READ,
        routes: [
          [FollowUpTasksController, 'list'],
          [FollowUpTasksController, 'summary'],
          [FollowUpTasksController, 'get'],
        ],
      },
    ],
  },
  {
    old: PERMISSIONS.PROCUREMENT_READ,
    stays: [
      [ProcurementController, 'listVendors'],
      [ProcurementController, 'listPos'],
      [ProcurementController, 'getPo'],
      [ProcurementController, 'listSubcontracts'],
      [ProcurementController, 'listLocations'],
      [ProcurementController, 'listStock'],
    ],
    moved: [
      {
        key: PERMISSIONS.REQUISITION_READ,
        routes: [
          [RequisitionsController, 'list'],
          [RequisitionsController, 'get'],
        ],
      },
    ],
  },
  {
    old: PERMISSIONS.LEDGER_READ,
    stays: [
      [ReportsController, 'trialBalance'],
      [ReportsController, 'generalLedger'],
      [InvoicesController, 'journal'],
      [InvoicesController, 'retention'],
    ],
    moved: [
      {
        key: PERMISSIONS.REPORT_READ,
        routes: [
          [ReportsController, 'poc'],
          [ReportsController, 'vatReturn'],
          [ReportsController, 'profitability'],
        ],
      },
      {
        key: PERMISSIONS.STATEMENT_READ,
        routes: [
          [ReportsController, 'incomeStatement'],
          [ReportsController, 'balanceSheet'],
          [FiscalController, 'years'],
        ],
      },
    ],
  },
];

const label = ([cls, method]: Route) => `${cls.name}.${method}`;

describe('the read routes of the split screens (P1-6)', () => {
  it('moves eleven routes to the four new keys', () => {
    expect(SPLITS.flatMap((s) => s.moved.flatMap((m) => m.routes))).toHaveLength(11);
  });

  for (const { old, stays, moved } of SPLITS) {
    describe(old, () => {
      it.each(stays.map((r) => [label(r), r] as const))('%s stays on the old key', (_l, route) => {
        expect(keyOf(route)).toEqual([old]);
      });

      for (const { key, routes } of moved) {
        it.each(routes.map((r) => [label(r), r] as const))(`%s moved to ${key}`, (_l, route) => {
          expect(keyOf(route)).toEqual([key]);
        });

        it(`a holder of ${old} alone is refused on the routes of ${key}, and the reverse`, () => {
          for (const route of routes) expect(reaches(route, [old])).toBe(false);
          for (const route of stays) expect(reaches(route, [key])).toBe(false);
        });
      }

      it('a role the migration extended reaches every route the old key reached before', () => {
        const extended = [old, ...moved.map((m) => m.key)];
        for (const route of [...stays, ...moved.flatMap((m) => m.routes)]) {
          expect(reaches(route, extended)).toBe(true);
        }
      });
    });
  }

  it('leaves the fiscal-year writes on finance.period.manage', () => {
    for (const method of Object.getOwnPropertyNames(FiscalController.prototype)) {
      if (method === 'constructor' || method === 'years') continue;
      expect(keyOf([FiscalController, method])).toEqual([PERMISSIONS.PERIOD_MANAGE]);
    }
  });
});
