# Architecture

WarmReach is a monorepo with three components: a React frontend, an Electron/Puppeteer client, and an AWS serverless backend.

> **Note:** Billing, relationship scoring, message intelligence, and advanced analytics are available in WarmReach Pro.

## Components

### Frontend (`frontend/`)

- **Stack**: React 18, TypeScript, Vite, Tailwind CSS
- **State**: React Query (`@tanstack/react-query`) for server state, React context for UI state
- **UI**: Radix UI primitives with Tailwind CSS
- **Organization**: Feature-based (`features/auth/`, `features/connections/`, `features/messages/`, `features/posts/`, etc.) with barrel exports
- **Communication**: HTTP to API Gateway (Cognito JWT auth), WebSocket for real-time command dispatch

### Client (`client/`)

- **Stack**: Electron tray app, Node.js/Express, Puppeteer
- **Organization**: Domain-driven (`src/domains/` — automation, connections, linkedin, messaging, profile, search, session, storage, workflow)
- **Transport**: WebSocket connection to backend for receiving commands from frontend
- **Automation**: Queue-based LinkedIn interaction processing with session preservation and checkpoint-based heal/restore recovery
- **Security**: Sealbox encryption (libsodium X25519) for LinkedIn credentials — decrypted just-in-time on the client, never sent to the cloud

### AWS Backend (`backend/`)

- **Stack**: AWS SAM, Python 3.13 Lambdas, DynamoDB, API Gateway V2, Cognito
- **Infrastructure** (defined in `template.yaml`):
  - **DynamoDB**: Single-table design (PK/SK + GSI1, TTL enabled)
  - **HTTP API**: API Gateway V2 with Cognito JWT authorizer
  - **WebSocket API**: API Gateway V2 for real-time command dispatch to Electron agent
  - **Cognito**: User pool with email-based auth

#### Lambda Functions

| Function           | Route                                     | Purpose                                                       |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------- |
| `command-dispatch` | `POST/GET /commands`                      | Command creation and dispatch to Electron agent via WebSocket |
| `dynamodb-api`     | `GET/POST /dynamodb`, `/profiles`         | User settings, profile CRUD                                   |
| `edge-processing`  | `POST /edges`, `/ragstack`                | Connection edge management, RAGStack search/ingest            |
| `llm`              | `POST /llm`                               | OpenAI/Bedrock AI operations (quota-metered)                  |
| `websocket-*`      | WebSocket `$connect/$disconnect/$default` | WebSocket lifecycle and message routing                       |

#### Shared Services (`lambdas/shared/python/`)

| Module                 | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `base_service.py`      | Base class for service layers                        |
| `websocket_service.py` | WebSocket @connections API helper                    |
| `ragstack_client.py`   | RAGStack GraphQL client with circuit breaker + retry |
| `circuit_breaker.py`   | Circuit breaker pattern                              |
| `ingestion_service.py` | Profile data ingestion                               |
| `observability.py`     | Correlation context and structured JSON logging      |

### RAGStack (optional nested stack)

[RAGStack-Lambda](https://github.com/HatmanStack/RAGStack-Lambda) provides vector embeddings and semantic search via AWS Bedrock Knowledge Base. Conditionally deployed via `DeployRAGStack` parameter, or connected externally via `RAGSTACK_GRAPHQL_ENDPOINT` and `RAGSTACK_API_KEY`.

## Data Flow

```
Frontend (React)
  +-- HTTP API -> Lambda (Cognito JWT)
  |     +-- /commands -> command-dispatch -> WebSocket -> Electron agent
  |     +-- /dynamodb, /profiles -> dynamodb-api -> DynamoDB
  |     +-- /edges, /ragstack -> edge-processing -> DynamoDB + RAGStack
  |     +-- /llm -> llm -> OpenAI API
  +-- WebSocket API -> Lambda
        +-- $connect -> JWT validation, connection tracking
        +-- $default -> message routing to Electron agent
        +-- $disconnect -> cleanup

Electron Client (user's machine)
  +-- WebSocket <- receives commands from backend
  +-- Puppeteer -> LinkedIn browser automation
  +-- HTTP -> edge-processing Lambda (profile ingestion)
  +-- Credentials stored locally only (Sealbox encrypted)
```

## DynamoDB Schema (single table)

| Entity          | PK                 | SK                              | Purpose                      |
| --------------- | ------------------ | ------------------------------- | ---------------------------- |
| User settings   | `USER#{sub}`       | `SETTINGS`                      | Preferences, LinkedIn config |
| Usage counters  | `USER#{sub}`       | `USAGE#daily` / `USAGE#monthly` | Quota metering               |
| Connection edge | `USER#{sub}`       | `PROFILE#{id_b64}`              | User-to-profile relationship |
| Profile edge    | `PROFILE#{id_b64}` | `USER#{sub}`                    | Reverse lookup               |
| WebSocket conn  | `WSCONN#{connId}`  | `CONN`                          | Active connection tracking   |
| Command         | `COMMAND#{cmdId}`  | `CMD`                           | Command state machine        |

## Authentication

- **Cloud API**: Cognito JWT in `Authorization: Bearer <token>` header
- **WebSocket**: JWT in query string at `$connect` time
- **Client <-> LinkedIn**: Sealbox-encrypted credentials (X25519 key exchange, libsodium)

## AI Services

- **OpenAI API**: Post idea generation (`gpt-4.1`), deep research (`o4-mini-deep-research`), synthesis (`gpt-5.2`)
- **AWS Bedrock**: RAGStack vector embeddings (Nova multimodal)
