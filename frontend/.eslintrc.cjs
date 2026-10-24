// ESLint configuration for ai-net frontend
// To enable Tailwind arbitrary-value warnings, install the plugin first:
//   npm install --save-dev eslint-plugin-tailwindcss
// Then uncomment the tailwindcss plugin block below.

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: [
    '@typescript-eslint',
    'react-hooks',
    // 'tailwindcss', // Uncomment after: npm install --save-dev eslint-plugin-tailwindcss
  ],
  extends: [
    'eslint:recommended',
    'plugin:react-hooks/recommended',
    // 'plugin:tailwindcss/recommended', // Uncomment after installing eslint-plugin-tailwindcss
  ],
  rules: {
    // Event-loop polling uses `while (true)` with internal breaks.
    'no-constant-condition': ['error', { checkLoops: false }],
    // Deliberate best-effort error handling relies on empty catch blocks.
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Disallow hardcoded hex colors and arbitrary rgba() values in className strings.
    // Full enforcement requires eslint-plugin-tailwindcss (not yet installed).
    // Once installed, enable:
    //   'tailwindcss/no-arbitrary-value': 'warn',
    //   'tailwindcss/classnames-order': 'warn',
  },
  settings: {
    // tailwindcss: {
    //   config: './tailwind.config.js',
    // },
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'public/mockServiceWorker.js',
    '*.config.js',
    '*.config.ts',
    '*.config.cjs',
  ],
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      // TypeScript-specific rules are enforced via `npm run typecheck` (tsc --noEmit).
      // The core rules below produce false positives on TS syntax/types when the
      // @typescript-eslint type-aware rules are not enabled.
      rules: {
        'no-undef': 'off',
        'no-redeclare': 'off',
        'no-dupe-class-members': 'off',
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'warn',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },
  ],
}
