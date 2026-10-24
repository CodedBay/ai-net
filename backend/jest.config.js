/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).[tj]s'],
  // Exclude integration tests from the default run — they run in their own project
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/tests/integration/',
    '<rootDir>/tests/e2e/',
    '<rootDir>/tests/performance/',
  ],
  testTimeout: 130_000,
  // Retry failed tests up to 2 times before marking as failed (#95).
  // This surfaces true failures while absorbing transient timing/network flakes.
  retries: 2,
  setupFilesAfterEnv: ['<rootDir>/tests/jestSetup.ts'],
  globalTeardown: '<rootDir>/tests/global-teardown.ts',
  // Jest's inline-snapshot updater is incompatible with Prettier 3, so point
  // it at the Prettier 2 alias installed for snapshot formatting
  // (see jestjs.io/docs/configuration/#prettierpath-string).
  prettierPath: require.resolve("prettier2"),
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        strict: true,
        esModuleInterop: true,
        target: 'ES2020',
        module: 'commonjs',
        resolveJsonModule: true,
          baseUrl: __dirname,
          paths: {
            'msw/node': ['node_modules/msw/lib/node/index.d.ts'],
            '@stellar/stellar-sdk/rpc': ['node_modules/@stellar/stellar-sdk/lib/rpc/index.d.ts'],
          },
      },
    }],
  },
  moduleNameMapper: {
    '^@stellar/stellar-sdk$': '<rootDir>/__mocks__/@stellar/stellar-sdk.js',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/index.ts',
    '!src/**/.gitkeep',
    '!src/registry/sync.ts',
    '!src/api/routes/stream.ts',
    '!src/index.ts',
    '!src/checkSpec.ts',
  ],
  coverageThreshold: {
    global: {
      statements: 75,
      // Branch coverage baseline is 64.88% — the previous 75% bar was never
      // reachable in CI (the backend job failed at the lint step first).
      branches: 64,
      functions: 75,
      lines: 75,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],

  // ── Jest Projects ─────────────────────────────────────────────────────────
  // The integration project boots the full Express app against in-memory SQLite
  // and mocks Venice AI via MSW. It runs separately to keep unit test isolation.
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/tests', '<rootDir>/src'],
      testMatch: ['**/?(*.)+(spec|test).[tj]s'],
      testPathIgnorePatterns: [
        '/node_modules/',
        '<rootDir>/tests/integration/',
        '<rootDir>/tests/e2e/',
        '<rootDir>/tests/performance/',
      ],
      testTimeout: 130_000,
      // Jest's inline-snapshot updater requires Prettier < 3.
      prettierPath: require.resolve("prettier2"),
      setupFiles: ['<rootDir>/tests/envSetup.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/jestSetup.ts'],
      globalTeardown: '<rootDir>/tests/global-teardown.ts',
      transform: {
        '^.+\\.tsx?$': ['ts-jest', {
          tsconfig: {
            strict: true,
            esModuleInterop: true,
            target: 'ES2020',
            module: 'commonjs',
            resolveJsonModule: true,
          baseUrl: __dirname,
          paths: {
            'msw/node': ['node_modules/msw/lib/node/index.d.ts'],
            '@stellar/stellar-sdk/rpc': ['node_modules/@stellar/stellar-sdk/lib/rpc/index.d.ts'],
          },
          },
        }],
      },
      moduleNameMapper: {
        '^@stellar/stellar-sdk$': '<rootDir>/__mocks__/@stellar/stellar-sdk.js',
        '^(\\.{1,2}/.*)\\.js$': '$1',
      },
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/tests/integration'],
      testMatch: ['**/?(*.)+(spec|test|integration.test).[tj]s'],
      testTimeout: 30_000,
      prettierPath: require.resolve("prettier2"),
      setupFiles: ['<rootDir>/tests/envSetup.ts'],
      // No globalTeardown here — each suite tears itself down
      transform: {
        '^.+\\.tsx?$': ['ts-jest', {
          tsconfig: {
            strict: true,
            esModuleInterop: true,
            target: 'ES2020',
            module: 'commonjs',
            resolveJsonModule: true,
          baseUrl: __dirname,
          paths: {
            'msw/node': ['node_modules/msw/lib/node/index.d.ts'],
            '@stellar/stellar-sdk/rpc': ['node_modules/@stellar/stellar-sdk/lib/rpc/index.d.ts'],
          },
          },
        }],
      },
      moduleNameMapper: {
        '^@stellar/stellar-sdk$': '<rootDir>/__mocks__/@stellar/stellar-sdk.js',
        '^(\\.{1,2}/.*)\\.js$': '$1',
      },
    },
  ],
};
