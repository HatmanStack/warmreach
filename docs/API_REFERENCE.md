# API Reference

Two API layers: the **Client Backend** (local Electron/Express for browser automation) and the **AWS Cloud API** (serverless Lambda functions).

> **Note:** Billing, relationship scoring, message intelligence, and advanced analytics are available in WarmReach Pro.

## Client Backend (Local)

Runs locally in the Electron tray app or as a standalone Express server on port 3001.

### Search & Discovery

| Endpoint          | Method | Description                                         |
| ----------------- | ------ | --------------------------------------------------- |
| `/search`         | `POST` | Execute a LinkedIn search with company/role filters |
| `/search/results` | `GET`  | Retrieve stored search results                      |
| `/search/health`  | `GET`  | Search service health check                         |

### LinkedIn Interactions

| Endpoint                                               | Method | Description                              |
| ------------------------------------------------------ | ------ | ---------------------------------------- |
| `/linkedin-interactions/send-message`                  | `POST` | Send a direct message to a connection    |
| `/linkedin-interactions/add-connection`                | `POST` | Send a connection request                |
| `/linkedin-interactions/create-post`                   | `POST` | Create and publish a LinkedIn post       |
| `/linkedin-interactions/generate-personalized-message` | `POST` | Generate AI-powered personalized message |
| `/linkedin-interactions/follow-profile`                | `POST` | Follow a LinkedIn profile                |
| `/linkedin-interactions/session-status`                | `GET`  | Get browser session state                |

### Profile Initialization

| Endpoint        | Method | Description                                         |
| --------------- | ------ | --------------------------------------------------- |
| `/profile-init` | `POST` | Initialize profile database and extract connections |

### System & Recovery

| Endpoint                  | Method | Description                                    |
| ------------------------- | ------ | ---------------------------------------------- |
| `/heal-restore/status`    | `GET`  | Check recovery system status                   |
| `/heal-restore/authorize` | `POST` | Authorize session recovery                     |
| `/heal-restore/cancel`    | `POST` | Cancel pending recovery                        |
| `/health`                 | `GET`  | System health, queue status, and configuration |
| `/config/status`          | `GET`  | Environment and feature configuration          |

### Rate Limits

| Route Group              | Limit      |
| ------------------------ | ---------- |
| `/search`                | 10 req/min |
| `/profile-init`          | 5 req/min  |
| `/linkedin-interactions` | 30 req/min |

---

## AWS Cloud API

All endpoints require a Cognito JWT in the `Authorization: Bearer <token>` header.

### Commands (WebSocket Dispatch)

| Endpoint                | Method | Description                                     |
| ----------------------- | ------ | ----------------------------------------------- |
| `/commands`             | `POST` | Create a command for dispatch to Electron agent |
| `/commands`             | `GET`  | List commands                                   |
| `/commands/{commandId}` | `GET`  | Get command status                              |
| `/commands/{commandId}` | `PUT`  | Update command state                            |

### Profile & Settings (DynamoDB API)

| Endpoint    | Method | Description                                                            |
| ----------- | ------ | ---------------------------------------------------------------------- |
| `/dynamodb` | `GET`  | Get user settings or profile metadata                                  |
| `/dynamodb` | `POST` | Operations: `create`, `update_user_settings`, `update_profile_picture` |
| `/profiles` | `GET`  | Get user profile data                                                  |
| `/profiles` | `POST` | Update user profile                                                    |

### AI & Processing

| Endpoint    | Method | Description                                                                                                               |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `/llm`      | `POST` | Operations: `generate_ideas`, `research_selected_ideas`, `get_research_result`, `synthesize_research`, `generate_message` |
| `/edges`    | `POST` | Operations: `get_connections_by_status`, `upsert_status`, `add_message`                                                   |
| `/ragstack` | `POST` | Operations: `search`, `ingest`, `status`, `scrape_start`, `scrape_status`                                                 |

## Authentication

- **Cloud API**: Cognito JWT — `Authorization: Bearer <token>`
- **Client Backend**: JWT token + encrypted LinkedIn credentials (Sealbox format)
