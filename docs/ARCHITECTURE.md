# Architecture

WarmReach is a monorepo with three components: a React frontend, an Electron/Puppeteer client, and an AWS serverless backend.

> **Note:** Billing (a separate pro-only `billing-api` Lambda on `POST /billing`), relationship scoring, message intelligence, tone analysis, send time recommendations, reply probability, priority inference, cluster detection, and advanced analytics are available in WarmReach Pro.

## Components

### Frontend (`frontend/`)

- **Stack**: React 19, TypeScript, Vite, Tailwind CSS
- **State**: React Query (`@tanstack/react-query`) for server state, React context for UI state
- **UI**: Radix UI primitives with Tailwind CSS
- **Organization**: Feature-based, 10 directories (`features/auth/`, `features/connections/`, `features/legal/`, `features/messages/`, `features/onboarding/`, `features/posts/`, `features/profile/`, `features/search/`, `features/tier/`, `features/workflow/`) with barrel exports
- **Communication**: HTTP to API Gateway (Cognito JWT auth), WebSocket for real-time command dispatch

### Client (`client/`)

- **Stack**: Electron tray app, Node.js/Express, Puppeteer
- **Organization**: Domain-driven, 10 directories (`src/domains/` — automation, connections, linkedin, messaging, navigation, profile, ragstack, search, session, storage)
- **Transport**: WebSocket connection to backend for receiving commands from frontend
- **Automation**: Queue-based LinkedIn interaction processing with session preservation and an in-process self-healing retry loop. On a recoverable failure the controller raises `HealingRequiredError`; the run-with-healing loop unwinds the attempt (its `finally` closes the browser) and re-invokes the phase from the resume state with a fresh browser, capped at `MAX_HEALING_ATTEMPTS` (3) so a persistently failing run ends in a real error. There is no checkpoint file and no worker process
- **Security**: LinkedIn credentials are encrypted at rest on the user's machine with Electron `safeStorage` (OS keyring). Separately, credentials arriving in a command payload use Sealbox (libsodium X25519), decrypted just-in-time on the client and never sent to the cloud

### AWS Backend (`backend/`)

- **Stack**: AWS SAM, Python 3.13 Lambdas, DynamoDB, API Gateway V2, Cognito
- **Infrastructure** (defined in `template.yaml`):
  - **DynamoDB**: Single-table design (PK/SK, TTL enabled) with two global secondary indexes — see [Global secondary indexes](#global-secondary-indexes)
  - **HTTP API**: API Gateway V2 with Cognito JWT authorizer
  - **WebSocket API**: API Gateway V2 for real-time command dispatch to Electron agent
  - **Cognito**: User pool with email-based auth

#### Lambda Functions

| Function               | Route                                     | Purpose                                                         |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `command-dispatch`     | `POST/GET /commands`                      | Command creation and dispatch to Electron agent via WebSocket   |
| `linkedin-action-gate` | `POST /linkedin-actions`                  | Quota-gated LinkedIn action dispatch (claim-before-send)        |
| `dynamodb-api`         | `GET/POST /dynamodb`, `/profiles`         | User settings, profile CRUD                                     |
| `edge-crud`            | `POST /edges`                             | Connection edge CRUD, notes, activity, lifecycle                |
| `ragstack-ops`         | `POST /ragstack`                          | RAGStack search, ingest, status proxy                           |
| `llm`                  | `POST /llm`                               | OpenAI AI operations (quota-metered)                            |
| `research-reconciler`  | EventBridge schedule                      | Scheduled deep-research poll and reconcile (reuses `lambdas/llm/`) |
| `client-downloads`     | `GET /client-downloads`                   | Per-platform desktop client download URLs (public, no JWT auth) |
| `websocket-*`          | WebSocket `$connect/$disconnect/$default` | WebSocket lifecycle and message routing                         |

#### Shared Services (`lambdas/shared/python/shared_services/`)

Every module that reaches this edition, derived from the sync exclusion list:

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

### RAGStack (optional nested stack)

[RAGStack-Lambda](https://github.com/HatmanStack/RAGStack-Lambda) provides vector embeddings and semantic search via AWS Bedrock Knowledge Base. Conditionally deployed via `DeployRAGStack` parameter, or connected externally via `RAGSTACK_GRAPHQL_ENDPOINT` and `RAGSTACK_API_KEY`.

## Data Flow

```
Frontend (React)
  +-- HTTP API -> Lambda (Cognito JWT)
  |     +-- /commands -> command-dispatch -> WebSocket -> Electron agent
  |     +-- /linkedin-actions -> linkedin-action-gate -> command-dispatch (in-process) -> WebSocket -> agent
  |     +-- /dynamodb, /profiles -> dynamodb-api -> DynamoDB
  |     +-- /edges -> edge-crud -> DynamoDB
  |     +-- /ragstack -> ragstack-ops -> DynamoDB + RAGStack
  |     +-- /llm -> llm -> OpenAI API
  +-- WebSocket API -> Lambda
        +-- $connect -> JWT validation, connection tracking
        +-- $default -> message routing to Electron agent
        +-- $disconnect -> cleanup

Electron Client (user's machine)
  +-- WebSocket <- receives commands from backend
  +-- Puppeteer -> LinkedIn browser automation
  +-- HTTP -> edge-crud Lambda (profile ingestion)
  +-- Credentials stored locally only (OS keyring via Electron safeStorage)
```

## DynamoDB Schema (single table)

| Entity          | PK                 | SK                              | Purpose                               |
| --------------- | ------------------ | ------------------------------- | ------------------------------------- |
| User settings   | `USER#{sub}`       | `SETTINGS`                      | Preferences, LinkedIn config          |
| Usage counters  | `USER#{sub}`       | `USAGE#…` (see below)           | Quota metering                        |
| Connection edge | `USER#{sub}`       | `PROFILE#{id_b64}`              | User-to-profile relationship          |
| Profile edge    | `PROFILE#{id_b64}` | `USER#{sub}`                    | Reverse lookup                        |
| WebSocket conn  | `WSCONN#{connId}`  | `CONN`                          | Active connection tracking            |
| Command         | `COMMAND#{cmdId}`  | `CMD`                           | Command item lifecycle (status field) |

### Global secondary indexes

Two, both on the single `ProfilesTable`. Built from `backend/template.yaml`.

| Index  | Key schema          | Projection | Serves                                                            |
| ------ | ------------------- | ---------- | ----------------------------------------------------------------- |
| `GSI1` | `GSI1PK` / `GSI1SK` | `ALL`      | The generic overloadable index; edge status queries               |
| `GSI3` | `GSI3PK` / `GSI3SK` | `ALL`      | Declared for single-table schema parity with WarmReach Pro. Sparse, and nothing in this edition writes its keys, so it is always empty and costs nothing |

The inverted `SK`/`PK` index that Pro carries is deliberately **not** declared
here. Every item has an `SK`, so an inverted index would add an entry on every
single write, and this edition has no reader for it — its two readers are Pro
Lambdas. That is also why GSI3 is kept and the inverted index is not: a sparse
index nobody writes is free; a dense one nobody reads is not.

**MiniStack creates `GSI1` only** (`scripts/ministack/init-aws.sh`), so local
integration tests cannot exercise a GSI3 query path.

### Usage keyspace

Counters live on `PK=USER#{sub}` with a `USAGE#`-prefixed sort key, and every
pattern carries a date or month suffix — a bare `USAGE#daily` row does not exist.

| Sort key                       | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `USAGE#daily#{YYYY-MM-DD}`     | LLM operations, daily                              |
| `USAGE#monthly#{YYYY-MM}`      | LLM operations, monthly                            |
| `USAGE#hourly#{YYYY-MM-DDTHH}` | Hourly LLM burst limit (read for limits reporting) |
| `USAGE#cost#monthly#{YYYY-MM}` | Per-user OpenAI spend attribution                  |

This edition has no quota enforcement — the monetization module is a no-op stub,
so the counters are written and never enforced against. The `USAGE#li-actions#*`
and `USAGE#deep-research#*` segments belong to WarmReach Pro features and no
code here writes them.

Note the naming: the quota fields named `*_linkedin_interactions` meter **LLM
operations**, not real LinkedIn actions. The name predates the split.

## Command vocabulary

`linkedin:add-connection` and its siblings are independently maintained string
literals in several places across two languages — the frontend's dispatchable
set, the client's route map and payload validators, and the action gate's gated
subset. Those sets express genuinely different subsets, so collapsing them into
one generated file would lose information.

Instead the vocabulary itself is a `frozenset` on the community-clean dispatch
core, and an unknown `command_type` is rejected with a returned 400 **before
anything is written**. A returned status is correct there: nothing was sent, so
it belongs on the clean-outcome channel rather than the maybe-sent one.

Before this, `create_command` accepted any string and persisted it, so a typo
produced a command that was written, rate-limited, dispatched over WebSocket, and
then silently unroutable at the client.

## Authentication

- **Cloud API**: Cognito JWT in `Authorization: Bearer <token>` header
- **WebSocket**: JWT in query string at `$connect` time
- **Client <-> LinkedIn**: Sealbox-encrypted credentials (X25519 key exchange, libsodium)

## AI Services

- **OpenAI API**: Post idea generation, deep research, synthesis, message generation, and analysis. Model ids are not hardcoded — every call site routes to a role in `shared_services/model_config.py` (`MODEL_GENERAL`, `MODEL_ANALYSIS`, `MODEL_DEEP_RESEARCH`), each env-overridable so an OpenAI retirement is answered by config rather than a deploy. Announced shutdown dates live in `MODEL_SHUTDOWNS` and are logged as a countdown on use. (The `DEFAULT_PLANNER_MODEL` role exists in the registry but its consumers — goal intelligence and the autonomous agent — are WarmReach Pro features absent from this edition.)
- **AWS Bedrock**: RAGStack vector embeddings (Nova multimodal)
