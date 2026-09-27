import { assertCopilotDatabaseUrl } from '../src/db';

describe('assertCopilotDatabaseUrl', () => {
  it('accepts a well-formed npi_copilot url', () => {
    const url = 'postgresql://u:p@localhost:5432/npi_copilot?schema=public';
    expect(assertCopilotDatabaseUrl(url)).toBe(url);
  });

  it('rejects the "npi" database', () => {
    expect(() => assertCopilotDatabaseUrl('postgresql://u:p@localhost:5432/npi')).toThrow();
  });

  it('rejects NPI\'s own database "npi_erp"', () => {
    expect(() => assertCopilotDatabaseUrl('postgresql://u:p@localhost:5432/npi_erp')).toThrow();
  });

  it('rejects a database name with a trailing suffix ("npi_copilot_x")', () => {
    expect(() =>
      assertCopilotDatabaseUrl('postgresql://u:p@localhost:5432/npi_copilot_x'),
    ).toThrow();
  });

  it('rejects a database name with a leading prefix ("xnpi_copilot")', () => {
    expect(() =>
      assertCopilotDatabaseUrl('postgresql://u:p@localhost:5432/xnpi_copilot'),
    ).toThrow();
  });

  it('rejects an undefined url', () => {
    expect(() => assertCopilotDatabaseUrl(undefined)).toThrow();
  });

  it('rejects an empty url', () => {
    expect(() => assertCopilotDatabaseUrl('')).toThrow();
  });

  it('rejects a non-postgres protocol', () => {
    expect(() => assertCopilotDatabaseUrl('mysql://u:p@localhost:3306/npi_copilot')).toThrow();
  });

  it('rejects a garbage string', () => {
    expect(() => assertCopilotDatabaseUrl('not a url at all')).toThrow();
  });

  it('never includes the password in the thrown message', () => {
    const secretPassword = 'sup3r-secret-password';
    const url = `postgresql://u:${secretPassword}@localhost:5432/npi_erp`;
    let message = '';
    try {
      assertCopilotDatabaseUrl(url);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(secretPassword);
    expect(message).not.toContain(url);
  });

  it('does not throw at import time when the env var is unset (guard is lazy)', async () => {
    await expect(import('../src/db')).resolves.toBeDefined();
  });
});
