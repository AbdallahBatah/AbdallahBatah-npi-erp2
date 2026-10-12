/**
 * Registration guard for the two hidden sections.
 *
 * The owner decided on 2026-10-12 to hide the plant-monitoring and PPA
 * sections. Their module folders and tables are kept on purpose (one
 * `git revert` restores everything), and registering either module in
 * AppModule again re-opens their twelve routes.
 */
import 'reflect-metadata';
import type { DynamicModule, Type } from '@nestjs/common';
import { AppModule } from './app.module';

/** An `imports` entry: a module class, a dynamic module, or a promise of one (ConfigModule.forRoot). */
type ModuleImport = Type<unknown> | DynamicModule | Promise<DynamicModule>;

const moduleName = (entry: Type<unknown> | DynamicModule): string =>
  typeof entry === 'function' ? entry.name : entry.module.name;

describe('AppModule registrations', () => {
  let registered: string[] = [];

  beforeAll(async () => {
    const entries = Reflect.getMetadata('imports', AppModule) as ModuleImport[];
    registered = (await Promise.all(entries)).map(moduleName);
  });

  it('does not register the hidden telemetry and PPA modules', () => {
    expect(registered).not.toContain('TelemetryModule');
    expect(registered).not.toContain('PpaModule');
  });

  it('still registers the neighbouring modules (so an empty list cannot pass)', () => {
    expect(registered).toEqual(expect.arrayContaining(['FsmModule', 'FinanceModule']));
  });
});
