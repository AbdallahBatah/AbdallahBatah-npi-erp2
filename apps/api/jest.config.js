/** Unit tests live next to the code as *.spec.ts. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  // Coverage lands at apps/api/coverage (not src/coverage): rootDir is src,
  // and the SonarCloud workflow reads apps/api/coverage/lcov.info.
  coverageDirectory: '<rootDir>/../coverage',
  testMatch: ['**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
};
