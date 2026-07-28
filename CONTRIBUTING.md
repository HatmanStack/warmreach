# Contributing to WarmReach

Thank you for your interest in contributing to WarmReach.

## Ethics

**Not for spam, mass outreach, or scraping.** All automation respects rate limits and mimics human interaction patterns.

## Getting Started

### Prerequisites

- Node.js 24+ (managed via nvm)
- Python 3.13 (managed via uv)
- AWS CLI configured for SAM deployment (backend)

### Setup

```bash
bash scripts/setup.sh
```

That is the supported path and it does everything: `npm ci` in the root and in
every sub-project, the Python test virtualenv from the hashed lock, and
`.env.example` -> `.env`.

**A root `npm install` installs the root devDependencies only.** The root
`package.json` has no `workspaces` key, so npm does not descend into
`frontend/`, `client/`, `admin/` or `mock-linkedin/` — measured on a clean tree:
after a root install, none of those four has a `node_modules/`. If you are doing
it by hand rather than with the script:

```bash
npm ci
(cd frontend && npm ci)
(cd client && npm ci)
(cd mock-linkedin && npm ci)
if [ -d admin ]; then (cd admin && npm ci); fi   # admin/ ships in WarmReach Pro only

# Backend test virtualenv
cd tests/backend && python3 -m venv .venv && . .venv/bin/activate \
  && uv pip install -r requirements-test.lock
```

Use `npm ci`, not `npm install`: it installs exactly what the lockfile pins and
fails rather than rewriting it, which is what keeps a local tree aligned with CI.

Then copy `.env.example` to `.env` and fill in required values.

### Local matches CI

Backend test dependencies install from `tests/backend/requirements-test.lock`
(pinned + hashed) in every environment: `scripts/setup.sh`, the manual setup
above, and CI (`.github/workflows/ci.yml`) all use the lock. This keeps a new
hire's local environment byte-for-byte aligned with CI and avoids "passes
locally, fails in CI." `requirements-test.txt` is only the loose-range input
used to regenerate the lock (`uv pip compile requirements-test.txt -o
requirements-test.lock`); never install from it directly.

## Development Workflow

1. Create a feature branch from `main`
1. Make changes following the code style guidelines below
1. Write tests for new functionality
1. Run `npm run check` to verify everything passes
1. Open a pull request

## Code Style

- **Frontend/Client/Admin**: Prettier for formatting, ESLint for linting
- **Backend**: Ruff for both formatting and linting
- **Pre-commit hooks**: Husky + lint-staged automatically runs Prettier, ESLint, and Ruff on staged files

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```text
type(scope): brief description
```

**Types**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`, `perf`

**Scopes**: `backend`, `client`, `frontend`, `admin`, `deps`

**Examples**:

```text
feat(frontend): add connection search filters
fix(backend): handle missing profile gracefully
refactor(client): extract messaging service
test(backend): add edge-crud handler tests
docs: update API reference
```

## Testing

```bash
# Full CI check (format + lint + typecheck + test)
npm run check

# Component-specific tests
npm run test:frontend    # Frontend Vitest
npm run test:client      # Client Vitest
npm run test:backend     # Backend pytest
npm run test:admin       # Admin Vitest

# Single test file
cd frontend && npx vitest run src/features/auth/hooks/useAuthFlow.test.ts
cd tests/backend && . .venv/bin/activate && python -m pytest unit/test_llm.py -v --tb=short
```

**Coverage threshold**: Backend requires 82% coverage. Frontend, client, and
admin workspaces enforce their own floors in each `vitest.config.{ts,js}`.

## Documentation Linting

Markdown files are checked by `markdownlint-cli2` and `lychee` (link checker). Both run in CI via `.github/workflows/docs-lint.yml` and **both block**: the markdownlint job runs the linter bare, so a non-zero exit fails the step, and the lychee job passes `fail: true`. A Markdown-style error or a broken link fails the PR. Run locally before pushing doc changes:

```bash
npm run lint:docs
```

Markdown auto-fixes run through `lint-staged` on `**/*.md` during commit. Configs live at `.markdownlint-cli2.jsonc` and `lychee.toml` at the repo root.

## Two-Repo Sync: Overlay Drift

When you modify a file listed in `.sync/config.json overlay_mappings`, you
must also update the corresponding overlay in `.sync/overlays/` in the same
PR. CI runs `scripts/check-overlay-drift.sh` and fails the build if the
overlay is stale. This keeps the community edition in parity with pro.

The same script also refuses a PR that **removes** an `exclude_paths` entry
without saying why. Deleting an exclusion publishes a pro-only path on the next
push to `main`, and that is unrecoverable once GitHub has forked or cached it.
If the removal is intended, state it in a commit body:

```text
sync-exclusion-removal: <the entry> — <why it is no longer pro-only>
```

## The other gates, and how to run them locally

Every one of these runs in CI. None needs a deploy, and all of them are
runnable before you push.

| Gate | Local command | What it catches |
| ---- | ------------- | --------------- |
| Publication leak scan | `bash scripts/check-sync-leak.sh` | Pro vocabulary in the tree the sync is about to publish. Builds the real synced tree through `.sync/sync.sh` and greps it, failing closed on any hit outside `.sync/leak-allowlist.txt` |
| Command-vocabulary drift | `python3 scripts/check-command-vocabulary.py` | The six independently-maintained lists of `linkedin:*` command types disagreeing across two languages |
| Doc-table parity | `python3 scripts/check-doc-tables.py` | The Lambda and shared-service tables in the reference docs drifting from `template.yaml` and `shared_services/` |
| Doc-linter inputs | `python3 scripts/check-doc-lint-inputs.py` | A literal doc-linter input the sync removes, which turns the community docs gate permanently red |
| Skipped tests | `bash scripts/check-skipped-tests.sh` | A `.skip(` / `xit(` / `@pytest.mark.skip` with no issue URL or `TODO(#NNN)` |
| Per-directory backend typecheck | `npm run typecheck:backend` | Type errors in a Lambda handler, not just in the shared layer — one mypy invocation per Lambda directory |
| Community-edition build | — (CI only) | The community edition failing to build, typecheck, or test. It builds the **synced tree**, so it sees breakage that linting the overlay in place structurally cannot |
| Commitlint | `npx commitlint --from origin/main --to HEAD` | A commit message that is not a Conventional Commit |
| End-to-end | `npx playwright test` | The browser-level failures the unit suites mock away |

Two of these are worth understanding rather than just running.

**The leak scan is the one that matters most.** `sync-public.yml` fires on every
push to `main`, holds a write deploy key, and ends in `git add -A && git push`.
The scan runs both in CI and inside `sync.sh` immediately before staging, so a
local sync run is guarded too.

**`check-overlay-drift.sh` unions the committed range with your working tree**,
so running it before committing means something. That was not true until
2026-07-27 — it compared a committed range only, and a real drift shipped that
way.

## Pull Request Process

1. One PR per feature or fix
1. CI must pass (`npm run check`)
1. Review required before merge
1. Squash merge to keep history clean

## Architecture Overview

WarmReach is a monorepo with three components, plus a fourth in WarmReach Pro:

- **frontend/**: React 19 + TypeScript + Vite
- **client/**: Electron tray app + Express + Puppeteer (LinkedIn automation)
- **backend/**: AWS SAM (Python 3.13 Lambdas, DynamoDB, Cognito, WebSocket API)
- **admin/**: React + TypeScript + Vite admin dashboard — **WarmReach Pro only**.
  This file syncs verbatim to the community edition, where `admin/` is absent;
  that is why every admin command here is guarded with `[ -d admin ]` and why
  `npm run test:admin`, `lint:admin`, `check`, and `format:check` skip it with a
  message rather than failing

See `CLAUDE.md` for detailed architecture documentation.
