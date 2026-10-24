const path = require('path');

let tsJestPath;
try {
  tsJestPath = require.resolve('ts-jest');
} catch {
  tsJestPath = 'ts-jest';
}

module.exports = {
  rootDir: path.resolve(__dirname, '../../backend'),
  roots: ['<rootDir>/../tests/e2e'],
  testMatch: ['<rootDir>/../tests/e2e/market-report-stellar.test.ts'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@stellar/stellar-sdk$': '<rootDir>/node_modules/@stellar/stellar-sdk',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [tsJestPath, {
      tsconfig: {
        strict: true,
        esModuleInterop: true,
        target: 'ES2020',
        module: 'commonjs',
        resolveJsonModule: true,
      },
    }],
  },
  testTimeout: 240_000,
};