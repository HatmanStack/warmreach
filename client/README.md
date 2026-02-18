# WarmReach Client

Electron tray app + Node.js automation backend for LinkedIn interactions with queue-based processing.

> **Active Development**: This service is under active development.

## Features

- **LinkedIn Automation**: Queue-based search, messaging, and connection management
- **Session Management**: Long-lived browser sessions with heal & restore capabilities
- **AWS Integration**: DynamoDB storage (via API Gateway) with encrypted credential management
- **Secure Processing**: Sealbox encryption and user data isolation
- **Error Recovery**: Checkpoint-based recovery for interrupted processes

## Quick Start

### Prerequisites

- Node.js 24+
- AWS credentials configured
- Chrome/Chromium browser

### Installation

```bash
cd client
npm install
cp .env.example .env
```

### Start Server

```bash
npm run dev    # Development
npm start      # Production
```

Server runs at `http://localhost:3001`

## API Endpoints

### Search

| Method | Path | Description |
|--------|------|-------------|
| POST | `/search/` | Execute LinkedIn search with company/role filters |

### Profile Initialization

| Method | Path | Description |
|--------|------|-------------|
| POST | `/profile-init/` | Initialize user profile and extract connections |
| GET | `/profile-init/health` | Profile init service health |

### LinkedIn Interactions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/linkedin-interactions/send-message` | Send message to connection |
| POST | `/linkedin-interactions/add-connection` | Send connection request |
| POST | `/linkedin-interactions/create-post` | Create LinkedIn post |
| POST | `/linkedin-interactions/follow-profile` | Follow a profile |
| POST | `/linkedin-interactions/generate-personalized-message` | Generate AI message |
| GET | `/linkedin-interactions/session-status` | Browser session status |

### Heal & Restore

| Method | Path | Description |
|--------|------|-------------|
| GET | `/heal-restore/status` | Check pending recovery sessions |
| POST | `/heal-restore/authorize` | Authorize session recovery |
| POST | `/heal-restore/cancel` | Cancel pending recovery |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | System health and queue status |
| GET | `/config/status` | Configuration report |

## Authentication

All `/search`, `/profile-init`, and `/linkedin-interactions` endpoints require:
- JWT token in `Authorization: Bearer <token>` header
- Encrypted LinkedIn credentials (sealbox format)

Heal/restore and health endpoints do not require authentication.

## Rate Limits

| Route Group | Limit |
|-------------|-------|
| `/search` | 10 req/min |
| `/profile-init` | 5 req/min |
| `/linkedin-interactions` | 30 req/min |

## Environment Variables

See `.env.example` for all configuration options. Key variables:

| Variable | Description |
|----------|-------------|
| `RAGSTACK_GRAPHQL_ENDPOINT` | RAGStack GraphQL API URL for profile scraping |
| `RAGSTACK_API_KEY` | API key for RAGStack authentication |
| `HEADLESS` | Browser headless mode (default: true) |
| `PORT` | Server port (default: 3001) |

## How It Works

1. **Authentication**: Secure credential decryption with Sealbox encryption
2. **Queue Processing**: FIFO queue serializes LinkedIn interactions
3. **Session Management**: Long-lived browser sessions minimize logins
4. **Profile Scraping**: RAGStack-based web scraping with cookie passthrough
5. **Recovery System**: Checkpoint-based recovery for interrupted processes

## Troubleshooting

- **Login Issues**: LinkedIn may require 2FA or CAPTCHA
- **Browser Crashes**: Monitor memory usage and restart if needed
- **Queue Stalls**: Check processing delays and job limits
- **AWS Permissions**: Verify IAM roles for DynamoDB access

## License

Apache 2.0 - see [LICENSE](https://www.apache.org/licenses/LICENSE-2.0.html)
