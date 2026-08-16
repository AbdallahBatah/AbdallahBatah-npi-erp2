/**
 * Integration tests — these talk to a real PostgreSQL and are deliberately kept
 * out of `npm test`.
 *
 * The unit config roots itself at `src`, so nothing under `test/` can be picked
 * up by it even by accident. Running these needs a database:
 *
 *   docker compose up -d postgres
 *   npm run db:deploy && npm run db:seed
 *   npm run test:int
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  // A serialization conflict plus retries is slower than any unit test.
  testTimeout: 60_000,
  // The chain assertions read org-wide state; parallel files would race.
  maxWorkers: 1,
};
