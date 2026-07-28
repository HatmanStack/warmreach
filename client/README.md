# WarmReach Client

Electron tray app + Node.js automation backend for LinkedIn interactions with queue-based processing.

> **Active Development**: This service is under active development.

## Features

- **LinkedIn Automation**: Queue-based search, messaging, and connection management
- **Session Management**: Long-lived browser sessions, rebuilt when the local session-health check fails
- **AWS Integration**: DynamoDB storage (via API Gateway) with encrypted credential management
- **Secure Processing**: Sealbox encryption and user data isolation
- **Error Recovery**: In-process retry from a resume state, up to three attempts, on a recoverable failure

## Quick Start

### Prerequisites

- Node.js 24+
- AWS credentials configured
- Chrome/Chromium browser

### Installation

```bash
cd client
npm install
# Configure the root .env file (not client-specific) — see .env.example
```

### Start Server

```bash
npm run dev    # Development
npm start      # Production
```

Server runs at `http://localhost:3001`

## API Endpoints

See [API Reference](../docs/API_REFERENCE.md) for the complete route documentation
including request/response schemas and authentication requirements.

## Authentication

All `/search`, `/profile-init`, and `/linkedin-interactions` endpoints require:
- JWT token in `Authorization: Bearer <token>` header
- Encrypted LinkedIn credentials (sealbox format)

The health and status endpoints require no authentication: `GET /health`,
`GET /config/status`, and `GET /profile-init/health`. (`/search` and
`/profile-init` enforce the JWT inside their controllers rather than through
router middleware, so their absence from a `router.use(...)` line is not an
absence of authentication.)

The auth-bridge routes `POST /auth/token` and `POST /auth/clear` are how the web
app hands this agent its Cognito tokens, so they carry no bearer token of their
own; `/auth/token` validates the token shapes it is given instead.

## Rate Limits

| Route Group | Limit |
|-------------|-------|
| `/search` | 10 req/min |
| `/profile-init` | 5 req/min |
| `/linkedin-interactions` | 30 req/min |
| `/auth/token` | 10 req/min |
| `/auth/clear` | 10 req/min |

## Environment Variables

See `.env.example` for all configuration options. Key variables:

| Variable | Description |
|----------|-------------|
| `HEADLESS` | Browser headless mode (default: true) |
| `PORT` | Server port (default: 3001) |

## How It Works

1. **Authentication**: Secure credential decryption with Sealbox encryption
2. **Queue Processing**: FIFO queue serializes LinkedIn interactions
3. **Session Management**: Long-lived browser sessions minimize logins
4. **Profile Scraping**: Puppeteer-driven page reads (`src/domains/linkedin/`) on the live authenticated session
5. **Recovery System**: A recoverable failure re-runs the phase from its resume state with a fresh browser, capped at three attempts

## Troubleshooting

- **Login Issues**: LinkedIn may require 2FA or CAPTCHA
- **Browser Crashes**: Monitor memory usage and restart if needed
- **Queue Stalls**: Check processing delays and job limits
- **AWS Permissions**: Verify IAM roles for DynamoDB access

## License

Apache 2.0 - see [LICENSE](https://www.apache.org/licenses/LICENSE-2.0.html)
