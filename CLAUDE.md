# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose & Ethics

**This tool is NOT for spam, mass outreach, or scraping LinkedIn.**

WarmReach helps users build more authentic professional relationships by surfacing buried interactions, identifying active connections, enabling thoughtful AI-assisted outreach, and providing network insight. All automation respects rate limits and mimics human interaction patterns.

This is the **Community Edition** — a free, self-deployable version of WarmReach.

Premium features (network graph visualization, relationship strength scoring, warm introduction paths, messaging intelligence, reply probability, advanced analytics) are available in WarmReach Pro.

### Community vs Pro

Community edition includes: LinkedIn automation, RAGStack integration, AI content generation, credential management, self-healing automation runs, and the full serverless backend.

Pro adds: network graph visualization, relationship strength scoring, cluster detection, warm intro paths, message intelligence, reply probability, best time to send, advanced analytics, priority inference, the opportunity tracker and its autonomous agent, goal intelligence, the weekly digest, billing/tier management, and usage quotas.

### How this repository is produced

This edition is generated from a private repository: files that are pro-only are omitted, and a handful that differ between editions are replaced with community versions that keep the same interfaces. Two consequences are worth knowing when reading the code here.

- **Some stubs exist purely for interface parity.** `shared_services/monetization.py` is the clearest case: its `QuotaService` and `FeatureFlagService` are no-ops where Pro meters and gates, so every `isinstance(e, QuotaExceededError)` check and every feature-flag call still type-checks and still runs. They are not dead code and should not be "cleaned up".
- **Pull requests here are checked against this tree only.** Before a change is published, CI runs Prettier, ESLint, Ruff, both TypeScript checks, a frontend production build, both SPA test suites, the backend test suite and `cfn-lint` — all against exactly the tree you see, so a change that compiles only against the Pro version does not reach you. `.env.example` is the community template, not the Pro one. **`sam build` is NOT among those checks**, so a template change is validated for syntax by `cfn-lint` but is not packaged; verify it yourself before deploying.

`docs/` describes this edition. Where a feature is Pro-only the docs say so rather than omitting it, so that an unexpected 404 or a disabled button has an explanation.

Two corrections to what that list used to say. **Tone analysis is not Pro-only** — `analyze_tone` is routed by this edition's `llm` handler and its flag is enabled here (`docs/API_REFERENCE.md` says the same). And "managed Puppeteer" was never built in either edition; it is a rejected idea, because cloud IPs conflict with the detection-avoidance the automation depends on.

The `shared_services/monetization.py` module contains no-op stubs. All Lambda code imports from this module. In Pro, it re-exports real quota/feature-flag/tier services; here it returns permissive defaults for core features only.

## Project Overview

WarmReach is a monorepo with three main components:

- **frontend/**: React 19 + TypeScript + Vite application
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
npm run lint:docs        # markdownlint (local); link check runs in CI. BLOCKING via docs-lint.yml
npm run lint:docs:links  # lychee link check, only if lychee is installed locally
npm run format           # Prettier write (frontend + client)

# Type checking
npm run typecheck:frontend
npm run typecheck:client
npm run typecheck:backend # mypy over backend shared_services (CI: backend job)

# API docs (typedoc TS + mkdocstrings Python) -> docs/api/ (gitignored)
npm run docs:api
npm run docs:api:ts
npm run docs:api:py

# Electron packaging
npm run electron:build
```

**Pre-commit hooks**: Husky + lint-staged auto-runs Prettier, ESLint, and Ruff on staged files.

## Architecture

### Frontend (`frontend/src/`)

Feature-based organization with barrel exports:

Ten feature directories:

- `features/auth/` - Cognito authentication
- `features/connections/` - LinkedIn connection management
- `features/legal/` - In-app legal texts and the acceptance gate
- `features/messages/` - Messaging system
- `features/onboarding/` - First-run onboarding flow
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
- `src/domains/` - Business logic by domain, 10 directories (automation, connections, linkedin, messaging, navigation, profile, ragstack, search, session, storage)
- `src/shared/` - Config, middleware, services, utils
- `src/server.js` - Express server entry point (local dev)

Queue-based LinkedIn interaction processing with session preservation and an in-process self-healing retry loop: a recoverable failure raises `HealingRequiredError`, and the run-with-healing loop re-invokes the phase from its resume state with a fresh browser, capped at `MAX_HEALING_ATTEMPTS` (3).

### AWS Backend (`backend/`)

SAM template (`template.yaml`) defines:

- **ProfilesTable**: DynamoDB single-table design (PK/SK + GSI1 and GSI3, TTL enabled — see [ARCHITECTURE.md](docs/ARCHITECTURE.md#global-secondary-indexes))
- **WebSocket API**: API Gateway V2 for real-time command dispatch
- **HttpApi**: API Gateway V2 with Cognito JWT authorizer
- **Cognito**: User pool with email-based auth
- **Lambda Functions** (Python 3.13):

| Function               | Purpose                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `command-dispatch`     | Command creation + WebSocket dispatch to the Electron agent                 |
| `linkedin-action-gate` | `POST /linkedin-actions` gated LinkedIn action dispatch (claim-before-send) |
| `dynamodb-api`         | User settings, profile CRUD, notifications                                  |
| `edge-crud`            | Edge CRUD, notes, activity, lifecycle, tagging                              |
| `ragstack-ops`         | RAGStack search, ingest, status proxy                                       |
| `llm`                  | OpenAI AI operations                                                        |
| `research-reconciler`  | Scheduled deep-research poll/reconcile (reuses `lambdas/llm/`)              |
| `client-downloads`     | `GET /client-downloads` per-platform download URLs (public, no JWT auth)    |
| `websocket-*`          | WebSocket lifecycle + message routing                                       |

Lambdas share code via `lambdas/shared/python/`. Every module that reaches this
edition:

| Module                            | Purpose                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `activity_service.py`             | Activity timeline query from DynamoDB                                              |
| `activity_writer.py`              | Fire-and-forget activity record writing                                            |
| `adjacency_service.py`            | Contact-to-contact adjacency store; no route persists to it here (ADR-015)         |
| `analytics_service.py`            | Dashboard aggregation (funnel, growth, engagement, usage)                          |
| `aws_clients.py`                  | Shared boto3 DynamoDB resource/client factories with explicit timeouts             |
| `base_service.py`                 | Base class for service layers                                                      |
| `circuit_breaker.py`              | Circuit breaker pattern                                                            |
| `cluster_detection_service.py`    | Attribute-based connection clustering                                              |
| `command_dispatch_core.py`        | Community-clean command-creation core (record, rate-limit, dispatch)               |
| `data_rights_service.py`          | GDPR/CCPA data export and account erasure                                          |
| `dynamodb_types.py`               | TypedDict definitions for DynamoDB item schemas                                    |
| `edge_constants.py`               | Edge-related constants                                                             |
| `edge_data_service.py`            | Edge CRUD operations (user-profile relationships) in DynamoDB                      |
| `edge_ingestion_service.py`       | Edge ingestion operations                                                          |
| `edge_message_service.py`         | Edge message operations                                                            |
| `edge_note_service.py`            | Edge note operations                                                               |
| `edge_opportunity_service.py`     | Edge opportunity tagging and staging                                               |
| `edge_query_service.py`           | Edge query operations                                                              |
| `edge_status_service.py`          | Edge status operations                                                             |
| `handler_utils.py`                | Shared handler utilities for Lambda routing, feature gating, and lazy service init |
| `ingestion_service.py`            | Profile data ingestion                                                             |
| `insight_cache_service.py`        | Insight caching with deduplicated 7-day TTL pattern                                |
| `legal_acceptance_service.py`     | Legal document acceptance records and the automation gate                          |
| `llm_cost.py`                     | OpenAI token accounting and per-user cost attribution                              |
| `message_intelligence_service.py` | Messaging pattern analysis                                                         |
| `message_utils.py`                | Shared message analysis utilities (response rate computation)                      |
| `model_config.py`                 | Central registry of OpenAI model ids (env-overridable)                             |
| `monetization.py`                 | No-op quota and feature-flag stubs (this edition has no billing)                   |
| `observability.py`                | Correlation context and structured logging                                         |
| `openai_retry.py`                 | Shared transient-error retry wrapper for OpenAI calls                              |
| `priority_inference_service.py`   | Connection engagement priority ranking                                             |
| `protocols.py`                    | Typing-only Protocol DI contracts for handler utilities                            |
| `ragstack_client.py`              | RAGStack GraphQL client (circuit breaker + retry)                                  |
| `ragstack_proxy_service.py`       | RAGStack search, ingest, and status proxy operations                               |
| `relationship_scoring_service.py` | Connection scoring (frequency, recency, reciprocity)                               |
| `reply_probability_service.py`    | Reply probability estimation from historical patterns                              |
| `request_utils.py`                | User ID extraction, CORS headers, and API response formatting                      |
| `send_time_service.py`            | Send-time recommendations from response patterns                                   |
| `ssm_cache.py`                    | SSM SecureString parameter caching with TTL                                        |
| `warm_intro_paths_service.py`     | Interface-compatible stub; the Pro service does the pathfinding (ADR-011)          |
| `websocket_service.py`            | WebSocket @connections API helper                                                  |

`errors/` holds the shared exception classes (`ServiceError`, `ValidationError`,
and siblings).

### RAGStack-Lambda (separate nested stack)

Optional nested stack from [RAGStack-Lambda](https://github.com/HatmanStack/RAGStack-Lambda):

- Vector embeddings + semantic search via Bedrock Knowledge Base
- Connected via `RAGSTACK_GRAPHQL_ENDPOINT` and `RAGSTACK_API_KEY` env vars
- Conditional deployment via `DeployRAGStack` parameter

### Test Structure

- **Frontend**: `frontend/src/**/*.test.{ts,tsx}` - Vitest + Testing Library
- **Client**: `client/src/**/*.test.{js,ts}` - Vitest
- **Backend**: `tests/backend/unit/` - pytest with moto (AWS mocking)
  - Coverage target: 82% (fail-under in pytest.ini)
  - `conftest.py` provides: DynamoDB table fixture, S3 bucket fixture, Lambda module loader (`load_lambda_module()`), service class loader (`load_service_class()`), factory fixtures (`create_test_edge()`, `create_test_profile()`, `create_authenticated_event()`)
- **E2E**: Playwright (`npm run test:e2e`)

## Key Technical Details

- **Authentication**: AWS Cognito with JWT tokens. LinkedIn credentials are encrypted at rest via Electron `safeStorage` (OS keyring); libsodium Sealbox separately covers credentials arriving in a command payload
- **Real-time**: WebSocket API Gateway for command dispatch: frontend -> backend -> Electron agent
- **State Management**: React Query (`@tanstack/react-query`)
- **UI Components**: Radix UI primitives with Tailwind CSS
- **Logging**: Winston (client), Python logging (lambdas)
- **AI Integration**: OpenAI API for all LLM operations; AWS Bedrock only for RAGStack vector embeddings. No Google Gemini.
- **Auto-update**: electron-updater publishing to GitHub Releases

## Environment Setup

Required `.env` variables (see `.env.example`):

- `VITE_API_GATEWAY_URL`, `VITE_COGNITO_*`, `VITE_WEBSOCKET_URL` - Frontend config
- `OPENAI_API_KEY_ARN` (SSM SecureString ARN) - AI config
- AWS credentials for SAM deployment

LinkedIn credentials live exclusively on-device in the desktop client,
encrypted at rest with Electron `safeStorage` (OS keyring). The cloud never
accepts, returns, or stores them.

See `docs/DEPLOYMENT.md` for deployment procedures.
