/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/db'],
  testMatch: ['**/*.migration.test.[tj]s'],
  testTimeout: 30000,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        strict: true,
        esModuleInterop: true,
        target: 'ES2020',
        module: 'commonjs',
        resolveJsonModule: true,
      },
    }],
  },
  // No moduleNameMapper — use the real better-sqlite3 native module
};
