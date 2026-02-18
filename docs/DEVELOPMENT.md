# Development Guide

This guide provides instructions for setting up your development environment and working with the WarmReach codebase.

## Prerequisites

-   **Node.js**: v24 LTS (managed via nvm)
-   **Python**: 3.13+ (for backend Lambdas)
-   **Docker**: For docker-compose local development and LocalStack
-   **Chrome/Chromium**: For Puppeteer automation
-   **jq**: For JSON processing in scripts (optional)
-   **libsodium-dev**: For Sealbox encryption in client
-   **AWS CLI**: Configured with appropriate credentials (for deployment)
-   **AWS SAM CLI**: For Lambda deployment
-   **OpenAI API Key**: For content generation features

## Initial Setup

The fastest way to set up is with the automated script:

```bash
git clone <repository-url>
cd warmreach
bash scripts/setup.sh
```

This will install all Node.js and Python dependencies, create a Python venv, and copy `.env.example` to `.env`.

### Manual Setup

If you prefer to set up manually:

1.  **Install Dependencies**:
    ```bash
    npm install
    cd frontend && npm install && cd ..
    cd client && npm install && cd ..
    cd mock-linkedin && npm install && cd ..
    ```

2.  **Python Test Environment**:
    ```bash
    cd tests/backend
    python -m venv .venv
    source .venv/bin/activate
    uv pip install -r requirements-test.lock --system
    cd ../..
    ```

3.  **Environment Configuration**:
    Copy the example environment file and fill in your values.
    ```bash
    cp .env.example .env
    ```
    See [CONFIGURATION.md](CONFIGURATION.md) for details on available settings.

4.  **Generate Encryption Keys**:
    Generate the necessary public/private key pairs for Sealbox encryption.
    ```bash
    node scripts/dev-tools/generate-device-keypair.js
    ```

## Docker Compose

The easiest way to run the full stack locally:

```bash
docker compose up --build
```

This starts:
- **LocalStack** (port 4566) — DynamoDB, S3, SQS, Cognito
- **localstack-init** — Provisions all AWS resources on startup
- **mock-linkedin** (port 3333) — Simulated LinkedIn pages
- **client-backend** (port 3001) — Automation backend
- **frontend** (port 5173) — Vite dev server

### LocalStack

LocalStack provides local AWS services. The init script (`scripts/localstack/init-aws.sh`) creates:
- DynamoDB table with PK/SK + GSI1 (matching SAM template)
- S3 bucket for screenshots
- SQS queues with DLQ redrive policy
- Cognito user pool with test user (`testuser@example.com` / `TestPass123!`)

Run integration tests against LocalStack:
```bash
docker compose up localstack -d
cd tests/backend && . .venv/bin/activate && pytest integration/ -v -m integration
```

## Testing Environments

This project supports multiple development modes to facilitate testing without always hitting real LinkedIn servers.

### 1. Mock Mode (Frontend + Mock Server)
**Best for**: UI development, testing flows without browser automation.
-   **Frontend**: Connects to the local Mock Server or Client Backend in testing mode.
-   **Mock Server**: Simulates LinkedIn pages and API responses.

```bash
# Terminal 1: Start Mock Server
cd mock-linkedin && npm start

# Terminal 2: Start Frontend
npm run dev
```

### 2. Hybrid Mode (Frontend + Client + Mock Server)
**Best for**: Testing the automation logic (Puppeteer) against a stable, offline target.
-   **Client Backend**: Configured to scrape `localhost:3333` instead of LinkedIn.
-   **Mock Server**: Serves the HTML pages.

**Configuration**:
In your root `.env` file:
```env
LINKEDIN_TESTING_MODE=true
LINKEDIN_BASE_URL=http://localhost:3333
```

**Run**:
```bash
# Terminal 1: Start Mock Server
cd mock-linkedin && npm start

# Terminal 2: Start Client Backend
npm run dev:client

# Terminal 3: Start Frontend
npm run dev
```

### 3. Full Development Mode (Frontend + Client + Real LinkedIn)
**Best for**: Final verification and real-world testing.
**Warning**: Use with caution to avoid account flagging. Respect rate limits.

**Configuration**:
In your root `.env` file:
```env
LINKEDIN_TESTING_MODE=false
# LINKEDIN_BASE_URL (comment out to use default)
```

**Run**:
```bash
# Terminal 1: Start Client Backend
npm run dev:client

# Terminal 2: Start Frontend
npm run dev
```

## Testing

### Frontend Tests
```bash
npm run test:frontend
```

### Backend (Lambda) Tests
These tests require the Python virtual environment to be activated.
```bash
cd tests/backend
source .venv/bin/activate
python -m pytest unit/ -v --tb=short
```

### Client Tests
```bash
npm run test:client
```

### End-to-End Tests

E2E tests use Playwright and are located in `tests/e2e/`.
```bash
npm run test:e2e
```

## Linting and Code Quality

Run all linting checks:
```bash
npm run lint
```

Or run them individually:
```bash
npm run lint:frontend
npm run lint:client
npm run lint:backend
```

## Project Structure

-   `frontend/`: React/Vite frontend application
-   `client/`: Electron tray app + Node.js/Express backend for browser automation
-   `backend/`: AWS SAM infrastructure and Lambda functions
-   `tests/`: Unit, integration, and E2E tests
-   `docs/`: Project documentation
-   `scripts/`: Utility scripts for deployment and development
