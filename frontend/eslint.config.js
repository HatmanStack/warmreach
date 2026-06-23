import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'coverage', '*.config.ts', '*.config.js'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Allow 'any' in test files and UI component library
    files: ['**/*.test.{ts,tsx}', '**/tests/**/*.{ts,tsx}', '**/ui/*.{ts,tsx}', '**/ui/**/*.{ts,tsx}', '**/setupTests.ts', '**/mockFactories.ts', '**/testHelpers.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // Disable react-refresh for context files and UI components (standard patterns)
    files: ['**/contexts/**/*.{ts,tsx}', '**/ui/**/*.{ts,tsx}', '**/components/StatusPicker.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Guardrail (audit Phase 5 / ADR-005): the API trust boundaries cleaned in
    // Phase 4 dropped their `as unknown as` double-casts in favor of genuinely
    // typed response narrowing. Lock that in. `@typescript-eslint/no-explicit-any`
    // is already 'error' repo-wide (from tseslint recommended), so this adds the
    // missing `as unknown as` ban. Scoped to the cleaned boundary files only; a
    // repo-wide ban surfaces pre-existing double-casts elsewhere (e.g.
    // useSearchResults, activityApiService, opportunityService) — future ratchet,
    // see Phase-5 Known Limitations.
    files: [
      'src/features/connections/hooks/useMessageIntelligence.ts',
      'src/features/tier/hooks/useCheckout.ts',
      'src/features/profile/contexts/UserProfileContext.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSUnknownKeyword',
          message:
            'No `as unknown as` double-casts at the API trust boundary. Narrow with a typed schema/guard instead (ADR-005).',
        },
      ],
    },
  },
)
