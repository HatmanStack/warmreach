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
# Install frontend, client, and admin dependencies
npm install

# Set up backend test virtualenv
cd tests/backend && uv venv .venv && source .venv/bin/activate && uv pip install -r requirements-test.lock
```

Copy `.env.example` to `.env` and fill in required values.

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

**Coverage threshold**: Backend requires 75% coverage. Frontend, client, and
admin workspaces enforce their own floors in each `vitest.config.{ts,js}`.

## Documentation Linting

Markdown files are checked by `markdownlint-cli2` and `lychee` (link checker). Both run in CI via `.github/workflows/docs-lint.yml` and are currently non-blocking while the baseline stabilizes. Run locally before pushing doc changes:

```bash
npm run lint:docs
```

Markdown auto-fixes run through `lint-staged` on `**/*.md` during commit. Configs live at `.markdownlint-cli2.jsonc` and `lychee.toml` at the repo root.

## Two-Repo Sync: Overlay Drift

When you modify a file listed in `.sync/config.json overlay_mappings`, you
must also update the corresponding overlay in `.sync/overlays/` in the same
PR. CI runs `scripts/check-overlay-drift.sh` and fails the build if the
overlay is stale. This keeps the community edition in parity with pro.

## Pull Request Process

1. One PR per feature or fix
1. CI must pass (`npm run check`)
1. Review required before merge
1. Squash merge to keep history clean

## Architecture Overview

WarmReach is a monorepo with four components:

- **frontend/**: React 19 + TypeScript + Vite
- **client/**: Electron tray app + Express + Puppeteer (LinkedIn automation)
- **backend/**: AWS SAM (Python 3.13 Lambdas, DynamoDB, Cognito, WebSocket API)
- **admin/**: React + TypeScript + Vite admin dashboard

See `CLAUDE.md` for detailed architecture documentation.
