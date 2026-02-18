import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },
  {
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      'no-console': 'error',
      'no-debugger': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.ts'],
    ...tseslint.configs.recommended[0],
    languageOptions: {
      ...tseslint.configs.recommended[0]?.languageOptions,
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      ...tseslint.configs.recommended[0]?.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
    },
  },
];
