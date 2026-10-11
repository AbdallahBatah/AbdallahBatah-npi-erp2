/** Unit tests live under tests/ (and next to source as *.spec.ts). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // Coverage of the copilot's own source only (not e2e fixtures or config
  // files), so the lcov report resolves cleanly in SonarCloud.
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/generated/**', '!src/**/*.spec.ts', '!src/npi/types.ts'],
  testMatch: ['<rootDir>/tests/**/*.spec.ts', '<rootDir>/src/**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
};
