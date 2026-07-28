# API Reference

Two API layers: the **Client Backend** (local Electron/Express for browser automation) and the **AWS Cloud API** (serverless Lambda functions).

> **Note:** Billing (a separate `POST /billing` endpoint in Pro, on Starter and Pro plans), relationship scoring, message intelligence, send time recommendations, reply probability, priority inference, cluster detection, advanced analytics, and the full pro LLM operation catalog (including `summarize_evidence`, `submit_feedback`, `get_feedback`, `get_pending_drafts`, `update_draft_status`) are available in WarmReach Pro. Note on `analyze_tone`: this edition's `llm` handler routes it, but no frontend surface reaches it — `useToneAnalysis` and `ToneAnalysisBadge` are stubs here, so the `tone_analysis` feature flag is **off**. The operation is listed below because the endpoint accepts it; the feature is not available in this edition.

## Client Backend (Local)

Runs locally in the Electron tray app or as a standalone Express server on port 3001.

### Search & Discovery

| Endpoint  | Method | Description                                         |
| --------- | ------ | --------------------------------------------------- |
| `/search` | `POST` | Execute a LinkedIn search with company/role filters |

### LinkedIn Interactions

| Endpoint                                | Method | Description                           |
| --------------------------------------- | ------ | ------------------------------------- |
| `/linkedin-interactions/send-message`   | `POST` | Send a direct message to a connection |
| `/linkedin-interactions/add-connection` | `POST` | Send a connection request             |
| `/linkedin-interactions/create-post`    | `POST` | Create and publish a LinkedIn post    |
| `/linkedin-interactions/follow-profile` | `POST` | Follow a LinkedIn profile             |
| `/linkedin-interactions/session-status` | `GET`  | Get browser session state             |

### Profile Initialization

| Endpoint               | Method | Description                                         |
| ---------------------- | ------ | --------------------------------------------------- |
| `/profile-init`        | `POST` | Initialize profile database and extract connections |
| `/profile-init/health` | `GET`  | Profile initialization service health check         |

### Auth Bridge

The web app posts Cognito tokens to the local agent so it can open its own
authenticated WebSocket to the cloud. Both routes are rate-limited to 10
req/min and return `204` on success, or `503` when the Electron main process
has not installed the bridge handler yet.

| Endpoint      | Method | Description                                                                 |
| ------------- | ------ | ---------------------------------------------------------------------------- |
| `/auth/token` | `POST` | Hand the agent an `idToken`, `refreshToken`, `cognitoClientId`, and `region` |
| `/auth/clear` | `POST` | Sign-out: make the agent forget the stored refresh token                    |

`/auth/clear` is not optional housekeeping. Refresh tokens are good for 30 days
by default, so without it the agent stays connected as the previous user — a
real problem on a shared machine.

### System & Recovery

| Endpoint         | Method | Description                                    |
| ---------------- | ------ | ---------------------------------------------- |
| `/health`        | `GET`  | System health, queue status, and configuration |
| `/config/status` | `GET`  | Environment and feature configuration          |

### Rate Limits

| Route Group              | Limit      |
| ------------------------ | ---------- |
| `/search`                | 10 req/min |
| `/profile-init`          | 5 req/min  |
| `/linkedin-interactions` | 30 req/min |
| `/auth/token`            | 10 req/min |
| `/auth/clear`            | 10 req/min |

---

## AWS Cloud API

All endpoints require a Cognito JWT in the `Authorization: Bearer <token>` header, except the public `/client-downloads` route and OPTIONS preflight requests.

### Commands (WebSocket Dispatch)

| Endpoint                | Method | Description                                     |
| ----------------------- | ------ | ----------------------------------------------- |
| `/commands`             | `POST` | Create a command for dispatch to Electron agent |
| `/commands/{commandId}` | `GET`  | Get command status                              |

### LinkedIn Actions (`/linkedin-actions`)

| Endpoint            | Method | Description                                                   |
| ------------------- | ------ | ------------------------------------------------------------- |
| `/linkedin-actions` | `POST` | User-initiated LinkedIn action dispatch to the Electron agent |

Served by the `linkedin-action-gate` Lambda, which dispatches the action to the Electron agent in-process via the community-clean command core (ADR-009).

Request body:

| Field            | Type   | Required | Description                                                                                                              |
| ---------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `type`           | string | yes      | One of `linkedin:add-connection`, `linkedin:send-message`, `linkedin:follow-profile`. Anything else returns `400 UNSUPPORTED_ACTION` — other command types belong on `POST /commands` |
| `payload`        | object | no       | Forwarded verbatim to the command core as the command payload; defaults to `{}`                                          |
| `idempotencyKey` | string | no       | Caller-generated key that makes a retry safe. Non-empty, at most 200 characters                                          |

#### Idempotency

`idempotencyKey` is optional, so existing callers keep working — but retrying
**without** one can double-send a real connect, message or follow.

The key is claimed with a conditional write **before** dispatch, so a retry
cannot send twice. Repeat requests with the same key, from the same user,
resolve as:

| Situation                     | Response                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Original still in flight      | `409` with `code: REQUEST_IN_PROGRESS`                                            |
| Original finished             | The recorded status and body are replayed verbatim — no second dispatch          |
| Key malformed                 | `400` with `code: INVALID_IDEMPOTENCY_KEY` (non-string, empty, or over 200 chars) |
| Idempotency store unreachable | `503` with `code: IDEMPOTENCY_UNAVAILABLE` — fail closed                          |

Keys expire after 24 hours, so the same key becomes reusable after that.

### Profile & Settings (DynamoDB API)

| Endpoint    | Method | Description                                                                                                                                                                                                                                                                          |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/dynamodb` | `GET`  | Get user settings, or profile metadata when a `profileId` query param is present. Query operations: `get_daily_scrape_count` (requires `date` param), `get_import_checkpoint`                                                                                                        |
| `/dynamodb` | `POST` | Operations: `create`, `update_user_settings`, `update_profile_picture`, `increment_daily_scrape_count`, `save_import_checkpoint`, `clear_import_checkpoint`, `complete_onboarding_step`, `get_legal_status`, `accept_legal_documents`, `export_my_data`, `delete_my_account`          |
| `/profiles` | `GET`  | Get user profile data                                                                                                                                                                                                                                                                |
| `/profiles` | `POST` | Update user profile                                                                                                                                                                                                                                                                  |

### Legal Acceptance

`get_legal_status` returns which documents the user still has to accept;
`accept_legal_documents` records acceptance.

This edition automates LinkedIn too, so the same server-side gate applies:
`POST /linkedin-actions` returns `403` with `code: LEGAL_ACCEPTANCE_REQUIRED`
until the LinkedIn risk disclosure has been accepted. Self-hosting does not
remove the risk to your LinkedIn account — see `docs/legal/`.

### Data Subject Rights

`export_my_data` returns everything held about the requesting account.
`delete_my_account` erases it and requires `{"confirm": "DELETE MY ACCOUNT"}` —
an erasure is irreversible, so the caller states intent explicitly. It is
idempotent, and returns 500 rather than 200 on a partial erasure so a subject is
never told their data is gone when some remains.

Scraped third-party profile records (`PROFILE#{id}`) are shared across every
account connected to that person, so they are neither exported nor deleted with
an individual account.

### AI & Processing

| Endpoint    | Method | Description                                                                                                                                           |
| ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/llm`      | `POST` | Operations: `generate_ideas`, `research_selected_ideas`, `get_research_result`, `get_active_research`, `cancel_research`, `synthesize_research`, `generate_message`, `analyze_message_patterns`, `analyze_tone`, `get_quota_status` |
| `/edges`    | `POST` | Operations: `get_connections_by_status`, `upsert_status`, `add_message`, `update_messages`, `get_messages`, `check_exists`, `add_note`, `update_note`, `delete_note`, `get_activity_timeline` |
| `/ragstack` | `POST` | Operations: `search`, `ingest`, `status`                                                                                                              |

`/ragstack` also routes `ingest_content` (ingesting a blog post or article
linked from a profile), but it is gated on the `blog_link_following` feature
flag, which this edition's stub reports as `false`. The route is present and
always answers `403 FEATURE_GATED`; the capability is available in WarmReach Pro.

`/edges` has no adjacency operation. Contact-to-contact adjacency persistence is
a Pro capability and the handler here does not register it, so `upsert_adjacency`
answers `400 Unsupported operation`. See
[ADR-015](adr/ADR-015-mutual-collection-sync-posture.md).

#### Deep research is asynchronous

`research_selected_ideas` starts an OpenAI **background** response and returns as
soon as the job is accepted, not when it finishes. It persists the OpenAI
response id against the job and flips the record to `in_progress`; the result
arrives later.

Callers poll `get_research_result` with the `job_id`. When the stored record
still has no content but carries a response id, the handler polls OpenAI
directly and, on `completed`, stores the content and returns it. The frontend
polls every 15 seconds.

`get_research_result` serves all three background kinds — ideas, research and
synthesis — selected by the optional `kind` field. `get_active_research` lists a
user's unfinished jobs so a reloaded client can resume polling, and
`cancel_research` stops one.

### Client Downloads (`/client-downloads`)

| Endpoint            | Method | Description                                                     |
| ------------------- | ------ | --------------------------------------------------------------- |
| `/client-downloads` | `GET`  | Per-platform desktop client download URLs (public, no JWT auth) |

Served by the `client-downloads` Lambda. Returns the per-platform download URLs from the `CLIENT_DOWNLOAD_{MAC,WIN,LINUX}` template parameters; `s3://` values are returned as short-lived presigned URLs.

## Authentication

- **Cloud API**: Cognito JWT — `Authorization: Bearer <token>`
- **Client Backend**: JWT token + encrypted LinkedIn credentials (Sealbox format)
