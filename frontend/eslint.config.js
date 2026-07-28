import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
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
    // Accessibility (audit Phase 8 / eval Tier 4 item 31). The previous phase
    // gave icon-only buttons accessible names, dialogs description
    // associations, inputs labels, progress surfaces live regions and the WebGL
    // network canvas a role — none of which survives without a rule enforcing
    // it.
    //
    // `flatConfigs.recommended.rules` carries 34 entries of which 31 are active
    // (anchor-ambiguous-text, control-has-associated-label and label-has-for
    // ship as 'off'). This block turns 5 of those 31 back off, leaving 26 —
    // and the scoped block below re-enables control-has-associated-label on 14
    // files, so `--print-config` resolves to 27 there and 26 elsewhere.
    // Measured 2026-07-27, the enabled set is green on the whole .tsx surface.
    // The five that are NOT enabled, with their measured counts, are a COUNTED
    // RATCHET — enable each as its violations are cleared, and do not remove one
    // from this list to make a change pass:
    //
    //   10  click-events-have-key-events          (6 files)
    //   10  label-has-associated-control          (4 files)
    //    8  no-static-element-interactions        (6 files)
    //    6  heading-has-content                   (3 files)
    //    1  no-noninteractive-element-interactions (1 file)
    //
    // The first three and the fifth need click handlers moved onto real
    // interactive elements and labels wired to controls — UI changes, not lint
    // fixes. heading-has-content is different: all 6 are the same false
    // positive, generic wrappers (CardTitle, AlertTitle, react-markdown heading
    // overrides) that spread `{...props}` — carrying `children` — into a
    // heading, which the rule cannot see through. Enabling it would cost six
    // line-level disables, which is how a gate becomes decoration.
    files: ['**/*.tsx'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/label-has-associated-control': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
      'jsx-a11y/heading-has-content': 'off',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
    },
  },
  {
    // `control-has-associated-label` is OFF in jsx-a11y's recommended set. It is
    // enabled here, scoped to the surfaces the previous phase's accessibility
    // work touched, which is the same shape as the ADR-005 guardrail below.
    // Repo-wide it reports 14 violations across 9 other files (measured
    // 2026-07-27 with the options below) — a counted ratchet; widening it is the
    // follow-up:
    //
    //    4  features/opportunities/components/EvidenceTab.tsx
    //    2  features/opportunities/components/RequirementsChecklist.tsx
    //    2  features/posts/components/PostAIAssistant.tsx
    //    1 each  legal/LegalAcceptanceGate, network/InfluencersTab,
    //            notifications/NotificationListItem, opportunities/GoalContextEditor,
    //            profile/CommentConciergeSettings,
    //            profile/NotificationPreferenceSelector
    //
    // WHAT THIS DOES AND DOES NOT CATCH, measured by mutation rather than
    // assumed. It catches a control with no accessible name where the element
    // itself is the control: deleting the aria-label from NetworkSidebar's
    // placeholder-only search input, or from AssessmentFeedback's feedback
    // textarea, fails. It does NOT catch an icon-only <button> whose child is a
    // component — `<button><Users /></button>` passes with no aria-label and no
    // title, because the rule cannot know that `<Users />` renders an icon
    // rather than text. The identical button with a literal `<svg />` child is
    // caught. Every icon in this codebase is a lucide-react component, so no
    // lint rule available here enforces icon-only button naming; that remains
    // covered by review and by the AuthForm/ConnectionNotesModal tests.
    files: [
      'src/features/auth/components/SignInForm.tsx',
      'src/features/auth/components/SignUpForm.tsx',
      'src/features/connections/components/AddContactDialog.tsx',
      'src/features/connections/components/ConnectionCard.tsx',
      'src/features/connections/components/ConnectionNotesModal.tsx',
      'src/features/connections/components/IcebreakerDialog.tsx',
      'src/features/messages/components/MessageModal.tsx',
      'src/features/network/components/NetworkGraph.tsx',
      'src/features/network/components/NetworkSidebar.tsx',
      'src/features/opportunities/components/AssessmentFeedback.tsx',
      'src/features/opportunities/components/CreateOpportunityDialog.tsx',
      'src/features/posts/components/NewPostTab.tsx',
      'src/features/profile/components/InterestsEditor.tsx',
      'src/features/workflow/components/ProgressIndicator.tsx',
    ],
    rules: {
      // Options are spelled out, not inherited. A severity-only override keeps
      // the options already configured — and jsx-a11y's recommended entry for
      // this rule carries ignoreElements including `input` and `textarea`, so
      // `'error'` alone silently exempts exactly the controls this is for.
      // Verified by mutation: with the inherited options, deleting the
      // aria-label from NetworkSidebar's placeholder-only search input still
      // passed.
      'jsx-a11y/control-has-associated-label': [
        'error',
        {
          ignoreElements: ['audio', 'canvas', 'embed', 'tr', 'video'],
          ignoreRoles: [
            'grid',
            'listbox',
            'menu',
            'menubar',
            'radiogroup',
            'row',
            'tablist',
            'toolbar',
            'tree',
            'treegrid',
          ],
          includeRoles: ['alert', 'dialog'],
        },
      ],
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
