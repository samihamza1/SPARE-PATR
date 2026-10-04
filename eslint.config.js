// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import i18next from 'eslint-plugin-i18next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Floats must never touch money or FX rates (CLAUDE.md invariant 1). */
const noFloatMoney = {
  'no-restricted-globals': [
    'error',
    { name: 'parseFloat', message: 'Money/FX must use the decimal utilities, never floats.' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.name='Number'], NewExpression[callee.name='Number']",
      message: 'Money/FX must use the decimal utilities, never floats.',
    },
    {
      selector: "CallExpression[callee.property.name='toNumber']",
      message: 'Do not convert decimals to JS numbers.',
    },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Number', property: 'parseFloat', message: 'Use parseDecimal().' },
    { property: 'toFixed', message: 'Use round() from the money utilities.' },
  ],
};

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'db/src/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['packages/shared/src/money/**/*.ts'],
    rules: noFloatMoney,
  },
  {
    files: ['apps/pos/src/**/*.{ts,tsx}', 'apps/backoffice/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // All UI strings go through i18n (CLAUDE.md invariant 8).
    files: ['apps/pos/src/**/*.tsx', 'apps/backoffice/src/**/*.tsx'],
    ...i18next.configs['flat/recommended'],
  },
  prettier,
);
