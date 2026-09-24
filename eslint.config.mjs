import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration focused on BUGS, not style.
 *
 * The type-checked rules below catch a class of defect `tsc` cannot see:
 * promises that are never awaited, async functions used where a synchronous
 * one is expected, and conditions that are always true. In a codebase that
 * fires real network traffic, a dropped promise is a silently lost result.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'apps/mobile/.expo/**',
      'artifacts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files and standalone tests sit outside the app tsconfigs.
          allowDefaultProject: [
            '*.js',
            '*.mjs',
            'apps/mobile/*.js',
            'apps/mobile/test/*.ts',
            'ops/*.mjs',
          ],
          // `ops/tsconfig.json` covers the standalone operator scripts so they
          // are type-aware linted instead of reported as parse errors.
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- real bug classes -------------------------------------------------
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-mixed-enums': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-return-assign': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-constant-binary-expression': 'error',
      'no-promise-executor-return': 'error',
      'require-atomic-updates': 'error',

      // --- deliberately off: noise, not bugs --------------------------------
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
  {
    // React hooks: exhaustive deps and the Rules of Hooks are the two highest
    // value checks in a React Native app — stale closures and conditional hooks
    // are both silent at runtime until they are not.
    files: ['apps/mobile/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Metro/Babel config and the operator scripts. These are Node programs, not
    // browser code, so the Node globals have to be declared explicitly —
    // otherwise every `Buffer`/`console` reference is a phantom `no-undef`.
    files: ['**/babel.config.js', '*.mjs', 'ops/**/*.mjs'],
    languageOptions: {
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // A hex dump builder legitimately interpolates a Buffer slice.
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    // Tests and scripts legitimately juggle loose shapes.
    files: ['**/test/**/*.ts', 'ops/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
