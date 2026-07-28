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
  // `tseslint.configs.recommended` is a three-element array: [0] is
  // typescript-eslint/base, which registers the plugin and parser and contains
  // ZERO rules; the 23 recommended rules live at [1] and [2]. Spreading only
  // [0] — as this config did until audit Phase 8 — left every recommended rule
  // silently off in client TS files. Spread the whole array, and scope `files`
  // onto each element with .map(): [0] is what registers the plugin, so
  // spreading just [1] and [2] fails with "could not find plugin
  // @typescript-eslint".
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
    },
  },
  {
    // Guardrail (audit Phase 5 / ADR-005): the WebSocket transport boundary uses
    // runtime-validated, typed command payloads instead of `as unknown as`
    // double-casts. `no-explicit-any` is now global (above), so only the
    // double-cast ban still needs this scope — it is deliberately not repo-wide,
    // because widening a double at a test-double boundary is legitimate and
    // banning it everywhere would push tests back toward `any`.
    files: [
      'src/transport/commandRouter.ts',
      'src/transport/commandRouter.schemas.ts',
      'src/domains/profile/controllers/profileInitController.ts',
      'src/domains/search/controllers/searchController.ts',
    ],
    rules: {
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
