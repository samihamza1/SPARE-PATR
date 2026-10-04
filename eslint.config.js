// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const moneyMessage =
  'Invariant 1: never use JS numbers for money or FX rates. Use dec()/Money from @autoparts/shared.';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', 'db/src/types.generated.ts']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      // Assertions on parsed data and fixtures read better without ceremony.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Guard rails for invariant 1 where money and DB values are handled.
    files: ['packages/shared/src/money/**/*.ts', 'db/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', { name: 'parseFloat', message: moneyMessage }],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='Number']", message: moneyMessage },
        { selector: "UnaryExpression[operator='+']", message: moneyMessage },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: moneyMessage },
        { object: 'Math', property: 'round', message: moneyMessage },
      ],
    },
  },
  {
    files: ['apps/pos/**/*.{ts,tsx}', 'apps/backoffice/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    // Invariant 8: all UI text goes through i18n.
    files: ['apps/pos/src/**/*.tsx', 'apps/backoffice/src/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-only',
          // Only attributes people read or hear are user-facing text; dir="ltr", route paths
          // and layout props are not.
          'jsx-attributes': {
            include: ['title', 'alt', 'placeholder', 'label', 'description', 'error', 'aria-.*'],
          },
          callees: {
            exclude: [
              'i18n(ext)?',
              't',
              'navigate',
              'require',
              'includes',
              'startsWith',
              'endsWith',
            ],
          },
        },
      ],
    },
  },
  prettier,
);
