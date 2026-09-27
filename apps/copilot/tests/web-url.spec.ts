// Unit tests for src/npi/web-url.ts (fix 3 of the design-critique pass).
import { npiWebUrl } from '../src/npi/web-url';

// @types/node types `NODE_ENV` as a read-only property of `ProcessEnv` —
// this cast is only so these tests can flip it back and forth.
type MutableEnv = Record<string, string | undefined>;

describe('npiWebUrl', () => {
  const ORIGINAL_NPI_WEB_URL = process.env.NEXT_PUBLIC_NPI_WEB_URL;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    if (ORIGINAL_NPI_WEB_URL === undefined) delete process.env.NEXT_PUBLIC_NPI_WEB_URL;
    else process.env.NEXT_PUBLIC_NPI_WEB_URL = ORIGINAL_NPI_WEB_URL;
    (process.env as MutableEnv).NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('uses NEXT_PUBLIC_NPI_WEB_URL when it is a non-empty string', () => {
    process.env.NEXT_PUBLIC_NPI_WEB_URL = 'https://npi.example.com';
    expect(npiWebUrl('/inbox')).toBe('https://npi.example.com/inbox');
  });

  it('strips a trailing slash from the configured base', () => {
    process.env.NEXT_PUBLIC_NPI_WEB_URL = 'https://npi.example.com/';
    expect(npiWebUrl('/inbox')).toBe('https://npi.example.com/inbox');
  });

  it('strips several trailing slashes from the configured base', () => {
    process.env.NEXT_PUBLIC_NPI_WEB_URL = 'https://npi.example.com///';
    expect(npiWebUrl('/inbox')).toBe('https://npi.example.com/inbox');
  });

  it('falls back to localhost:3000 outside production when the env var is unset', () => {
    delete process.env.NEXT_PUBLIC_NPI_WEB_URL;
    (process.env as MutableEnv).NODE_ENV = 'development';
    expect(npiWebUrl('/inbox')).toBe('http://localhost:3000/inbox');
  });

  it('falls back to localhost:3000 outside production when the env var is an empty string', () => {
    process.env.NEXT_PUBLIC_NPI_WEB_URL = '';
    (process.env as MutableEnv).NODE_ENV = 'test';
    expect(npiWebUrl('/inbox')).toBe('http://localhost:3000/inbox');
  });

  it('resolves to the empty string (same origin) in production with no env var set', () => {
    delete process.env.NEXT_PUBLIC_NPI_WEB_URL;
    (process.env as MutableEnv).NODE_ENV = 'production';
    expect(npiWebUrl('/inbox')).toBe('/inbox');
  });

  it('passes the path through unchanged (root path)', () => {
    process.env.NEXT_PUBLIC_NPI_WEB_URL = 'https://npi.example.com';
    expect(npiWebUrl('/')).toBe('https://npi.example.com/');
  });

  it('throws when path does not start with "/"', () => {
    process.env.NEXT_PUBLIC_NPI_WEB_URL = 'https://npi.example.com';
    expect(() => npiWebUrl('inbox')).toThrow();
  });
});
