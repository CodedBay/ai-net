// ESLint configuration for ai-net backend.
// TypeScript-specific correctness is enforced via `npm run typecheck`;
// eslint handles JS-level correctness and cross-file hygiene.
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended'],
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    '*.cjs',
    '*.config.js',
    'scripts/',
  ],
  rules: {
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Input sanitizers intentionally strip control characters.
    'no-control-regex': 'off',
    'no-constant-condition': ['error', { checkLoops: false }],
  },
  overrides: [
    {
      files: ['**/*.ts'],
      rules: {
        // tsc owns global/type/redeclaration validation for TypeScript
        // sources (declaration merging, method overloads, etc.).
        'no-undef': 'off',
        'no-redeclare': 'off',
        'no-dupe-class-members': 'off',
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'warn',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
      },
    },
  ],
};
