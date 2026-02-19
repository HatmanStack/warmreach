# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose & Ethics

**This tool is NOT for spam, mass outreach, or scraping LinkedIn.**

WarmReach helps users build more authentic professional relationships by surfacing buried interactions, identifying active connections, enabling thoughtful AI-assisted outreach, and providing network insight. All automation respects rate limits and mimics human interaction patterns.

This is the **Community Edition** — a free, self-deployable version of WarmReach.

Premium features (network graph visualization, relationship strength scoring, warm introduction paths, messaging intelligence, reply probability, advanced analytics) are available in WarmReach Pro.

### Community vs Pro

Community edition includes: LinkedIn automation, RAGStack integration, AI content generation, credential management, heal & restore, and the full serverless backend.

Pro adds: network graph visualization, relationship strength scoring, cluster detection, warm intro paths, message intelligence, reply probability, tone analysis, best time to send, advanced analytics, priority inference, managed Puppeteer, billing/tier management, and usage quotas.

The `shared_services/monetization.py` module contains no-op stubs. All Lambda code imports from this module. In Pro, it re-exports real quota/feature-flag/tier services; here it returns permissive defaults for core features only.

## Project Overview

WarmReach is a monorepo with three main components:
- **frontend/**: React 18 + TypeScript + Vite application
- **client/**: Electron tray app + Node.js Express backend with Puppeteer for LinkedIn automation
- **backend/**: AWS SAM serverless stack (Python 3.13 Lambdas + DynamoDB + Cognito + WebSocket API)

## Build & Development Commands

```bash
# Full CI check (format + lint + typecheck + test)
npm run check

# Development
npm run dev              # Frontend Vite dev server (localhost:5173)
npm run dev:client       # Client Express backend (localhost:3001)
npm run electron:dev     # Electron tray app

# Testing (from repo root)
npm run test             # All tests (frontend + client + backend)
npm run test:frontend    # Frontend Vitest only
npm run test:client      # Client Vitest only
npm run test:backend     # Backend pytest only

# Run a single frontend test file
cd frontend && npx vitest run src/features/auth/components/AuthForm.test.tsx

# Run a single backend test file
cd tests/backend && . .venv/bin/activate && python -m pytest unit/test_llm.py -v --tb=short

# Run a single backend test function
cd tests/backend && . .venv/bin/activate && python -m pytest unit/test_llm.py::test_generate_ideas_success -v

# Linting
npm run lint             # All (frontend ESLint + client ESLint + backend Ruff)
npm run lint:backend     # Ruff check + format check
npm run format           # Prettier write (frontend + client)

# Type checking
npm run typecheck:frontend
npm run typecheck:client

# Electron packaging
npm run electron:build
```

**Pre-commit hooks**: Husky + lint-staged auto-runs Prettier, ESLint, and Ruff on staged files.

## Architecture

### Frontend (`frontend/src/`)
Feature-based organization with barrel exports:
- `features/auth/` - Cognito authentication
- `features/connections/` - LinkedIn connection management
- `features/messages/` - Messaging system
- `features/posts/` - Post creation with AI
- `features/profile/` - User profile management
- `features/search/` - LinkedIn search
- `features/tier/` - Community tier stub (all features enabled)
- `features/workflow/` - Automation workflows
- `shared/` - Reusable components, hooks, services, utils, types
- `shared/services/websocketService.ts` - WebSocket connection manager
- `shared/services/commandService.ts` - Command dispatch to Electron agent

Path aliases (configured in `tsconfig.json` and `vite.config.ts`):
- `@/components` -> `src/shared/components`
- `@/hooks` -> `src/shared/hooks`
- `@/services` -> `src/shared/services`
- `@/utils` -> `src/shared/utils`
- `@` -> `src`

### Client (`client/`)
Electron tray app + Express backend with domain-driven architecture:
- `electron-main.js` - Electron main process (tray-only, auto-updater)
- `src/transport/` - WebSocket client + command router
- `src/auth/` - Electron Cognito authentication (libsodium Sealbox encryption)
- `src/credentials/` - LinkedIn credential store + settings window
- `src/domains/` - Business logic by domain (automation, connections, linkedin, messaging, navigation, profile, ragstack, search, session, storage, workflow)
- `src/shared/` - Config, middleware, services, utils
- `src/server.js` - Express server entry point (local dev)

Queue-based LinkedIn interaction processing with session preservation and heal/restore capabilities.

### AWS Backend (`backend/`)
SAM template (`template.yaml`) defines:
- **ProfilesTable**: DynamoDB single-table design (PK/SK + GSI1, TTL enabled)
- **WebSocket API**: API Gateway V2 for real-time command dispatch
- **HttpApi**: API Gateway V2 with Cognito JWT authorizer
- **Cognito**: User pool with email-based auth
- **Lambda Functions** (Python 3.13):
  - `websocket-connect/disconnect/default/` - WebSocket lifecycle + message routing
  - `command-dispatch/` - Command creation and dispatch to agent
  - `edge-processing/` - Edge data processing + RAGStack search/ingest
  - `dynamodb-api/` - User settings/profile CRUD
  - `llm/` - OpenAI/Bedrock LLM operations

Lambdas share code via `lambdas/shared/python/`:
- `shared_services/base_service.py` - Base class for all service layers
- `shared_services/websocket_service.py` - WebSocket @connections API helper
- `shared_services/monetization.py` - Community edition stubs (all features enabled)
- `shared_services/ragstack_client.py` - RAGStack GraphQL client with circuit breaker + retry
- `shared_services/circuit_breaker.py` - Circuit breaker pattern (public API: `on_success()`/`on_failure()`)
- `shared_services/ingestion_service.py` - Profile data ingestion
- `shared_services/observability.py` - Correlation context and logging
- `errors/` - Shared exception classes (`ServiceError`, `ValidationError`, etc.)

### RAGStack-Lambda (separate nested stack)
Optional nested stack from [RAGStack-Lambda](https://github.com/HatmanStack/RAGStack-Lambda):
- Vector embeddings + semantic search via Bedrock Knowledge Base
- Connected via `RAGSTACK_GRAPHQL_ENDPOINT` and `RAGSTACK_API_KEY` env vars
- Conditional deployment via `DeployRAGStack` parameter

### Test Structure
- **Frontend**: `frontend/src/**/*.test.{ts,tsx}` - Vitest + Testing Library
- **Client**: `client/src/**/*.test.js` - Vitest
- **Backend**: `tests/backend/unit/` - pytest with moto (AWS mocking)
  - Coverage target: 75% (fail-under in pytest.ini)
  - `conftest.py` provides: DynamoDB table fixture, S3 bucket fixture, Lambda module loader (`load_lambda_module()`), service class loader (`load_service_class()`), factory fixtures (`create_test_edge()`, `create_test_profile()`, `create_authenticated_event()`)
- **E2E**: Playwright (`npm run test:e2e`)

## Key Technical Details

- **Authentication**: AWS Cognito with JWT tokens, credentials encrypted with libsodium (Sealbox)
- **Real-time**: WebSocket API Gateway for command dispatch: frontend -> backend -> Electron agent
- **State Management**: React Query (`@tanstack/react-query`)
- **UI Components**: Radix UI primitives with Tailwind CSS
- **Logging**: Winston (client), Python logging (lambdas)
- **AI Integration**: OpenAI API + AWS Bedrock (configurable model ID). No Google Gemini.
- **Auto-update**: electron-updater publishing to GitHub Releases

## Environment Setup

Required `.env` variables (see `.env.example`):
- `VITE_API_URL`, `VITE_COGNITO_*`, `VITE_WEBSOCKET_URL` - Frontend config
- `OPENAI_API_KEY`, `BEDROCK_MODEL_ID` - AI config
- AWS credentials for SAM deployment

See `docs/DEPLOYMENT.md` for deployment procedures.
