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
  {
    // Guardrail (audit Phase 5 / ADR-005): the WebSocket transport boundary was
    // cleaned in Phase 4 to use runtime-validated, typed command payloads instead of
    // `Record<string, any>` and `as unknown as` double-casts. Lock that in so it
    // cannot silently regress. The profile-init and search controller boundaries
    // were likewise typed in audit Phase 7 (removing ~17/~14 `any`-class usages and
    // a `@ts-expect-error`) and are ratcheted alongside the transport boundary here.
    // Scoped to the cleaned boundary files only; a repo-wide ban surfaces pre-existing
    // `Record<string, any>` across the client domains (future ratchet — see Phase-5
    // Known Limitations).
    files: [
      'src/transport/commandRouter.ts',
      'src/transport/commandRouter.schemas.ts',
      'src/domains/profile/controllers/profileInitController.ts',
      'src/domains/search/controllers/searchController.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSUnknownKeyword',
          message:
            'No `as unknown as` double-casts at the transport boundary. Validate the payload (see commandRouter.schemas.ts) and narrow with a typed schema instead (ADR-005).',
        },
      ],
    },
  },
];
