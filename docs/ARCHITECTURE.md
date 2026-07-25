# Architecture

WarmReach is a monorepo with three components: a React frontend, an Electron/Puppeteer client, and an AWS serverless backend.

> **Note:** Billing (a separate pro-only `billing-api` Lambda on `POST /billing`), relationship scoring, message intelligence, tone analysis, send time recommendations, reply probability, priority inference, cluster detection, and advanced analytics are available in WarmReach Pro.

## Components

### Frontend (`frontend/`)

- **Stack**: React 19, TypeScript, Vite, Tailwind CSS
- **State**: React Query (`@tanstack/react-query`) for server state, React context for UI state
- **UI**: Radix UI primitives with Tailwind CSS
- **Organization**: Feature-based (`features/auth/`, `features/connections/`, `features/messages/`, `features/posts/`, etc.) with barrel exports
- **Communication**: HTTP to API Gateway (Cognito JWT auth), WebSocket for real-time command dispatch

### Client (`client/`)

- **Stack**: Electron tray app, Node.js/Express, Puppeteer
- **Organization**: Domain-driven (`src/domains/` — automation, connections, linkedin, messaging, navigation, profile, ragstack, search, session, storage, workflow)
- **Transport**: WebSocket connection to backend for receiving commands from frontend
- **Automation**: Queue-based LinkedIn interaction processing with session preservation and checkpoint-based heal/restore recovery
- **Security**: LinkedIn credentials are encrypted at rest on the user's machine with Electron `safeStorage` (OS keyring). Separately, credentials arriving in a command payload use Sealbox (libsodium X25519), decrypted just-in-time on the client and never sent to the cloud

### AWS Backend (`backend/`)

- **Stack**: AWS SAM, Python 3.13 Lambdas, DynamoDB, API Gateway V2, Cognito
- **Infrastructure** (defined in `template.yaml`):
  - **DynamoDB**: Single-table design (PK/SK + GSI1, TTL enabled). Available in WarmReach Pro: GSI2 for paid-user queries.
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
| `analytics-insights`   | `POST /analytics`                         | Insights, analytics, and scoring operations                     |
| `llm`                  | `POST /llm`                               | OpenAI AI operations (quota-metered)                            |
| `client-downloads`     | `GET /client-downloads`                   | Per-platform desktop client download URLs (public, no JWT auth) |
| `websocket-*`          | WebSocket `$connect/$disconnect/$default` | WebSocket lifecycle and message routing                         |

#### Shared Services (`lambdas/shared/python/shared_services/`)

| Module                     | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `base_service.py`          | Base class for service layers                                        |
| `websocket_service.py`     | WebSocket @connections API helper                                    |
| `ragstack_client.py`       | RAGStack GraphQL client with circuit breaker + retry                 |
| `circuit_breaker.py`       | Circuit breaker pattern                                              |
| `command_dispatch_core.py` | Community-clean command-creation core (record, rate-limit, dispatch) |
| `ingestion_service.py`     | Profile data ingestion                                               |
| `observability.py`         | Correlation context and structured JSON logging                      |
| `message_utils.py`         | Shared message analysis utilities                                    |
| `model_config.py`          | Central registry of OpenAI model ids (env-overridable)               |
| `dynamodb_types.py`        | TypedDict definitions for DynamoDB item schemas                      |
| `protocols.py`             | Typing-only Protocol DI contracts for handler utilities              |

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
  |     +-- /analytics -> analytics-insights -> DynamoDB
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
| Usage counters  | `USER#{sub}`       | `USAGE#daily` / `USAGE#monthly` | Quota metering                        |
| Connection edge | `USER#{sub}`       | `PROFILE#{id_b64}`              | User-to-profile relationship          |
| Profile edge    | `PROFILE#{id_b64}` | `USER#{sub}`                    | Reverse lookup                        |
| WebSocket conn  | `WSCONN#{connId}`  | `CONN`                          | Active connection tracking            |
| Command         | `COMMAND#{cmdId}`  | `CMD`                           | Command item lifecycle (status field) |

## Authentication

- **Cloud API**: Cognito JWT in `Authorization: Bearer <token>` header
- **WebSocket**: JWT in query string at `$connect` time
- **Client <-> LinkedIn**: Sealbox-encrypted credentials (X25519 key exchange, libsodium)

## AI Services

- **OpenAI API**: Post idea generation, deep research, synthesis, message generation, and analysis. Model ids are not hardcoded — every call site routes to a role in `shared_services/model_config.py` (`MODEL_GENERAL`, `MODEL_ANALYSIS`, `MODEL_DEEP_RESEARCH`), each env-overridable so an OpenAI retirement is answered by config rather than a deploy. Announced shutdown dates live in `MODEL_SHUTDOWNS` and are logged as a countdown on use. (The `DEFAULT_PLANNER_MODEL` role exists in the registry but its consumers — goal intelligence and the autonomous agent — are WarmReach Pro features absent from this edition.)
- **AWS Bedrock**: RAGStack vector embeddings (Nova multimodal)
