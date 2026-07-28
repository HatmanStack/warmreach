# Development Guide

This guide provides instructions for setting up your development environment and working with the WarmReach codebase.

## Prerequisites

-   **Node.js**: v24 LTS (managed via nvm)
-   **Python**: 3.13+ (for backend Lambdas)
-   **Docker**: For docker-compose local development and MiniStack
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
cd <the cloned directory>   # warmreach-pro, or warmreach for the community edition
bash scripts/setup.sh
```

The script checks for `node`, `npm`, `docker`, `python3` and `uv` up front and
exits if any is missing, then runs `npm ci` in the root and in `frontend/`,
`client/`, `mock-linkedin/` and `admin/` (skipped when `admin/` is absent, which
it is in the community edition), creates `tests/backend/.venv` and installs from
`requirements-test.lock`, and copies `.env.example` to `.env` if you do not
already have one. It does **not** generate the Sealbox keypair — that is step 4
below.

### Manual Setup

If you prefer to set up manually:

1.  **Install Dependencies**: there is no `workspaces` key in the root
    `package.json`, so a root install does not descend into the sub-projects —
    each one needs its own. Use `npm ci` rather than `npm install`, matching
    `scripts/setup.sh` and CI.
    ```bash
    npm ci
    (cd frontend && npm ci)
    (cd client && npm ci)
    (cd mock-linkedin && npm ci)
    if [ -d admin ]; then (cd admin && npm ci); fi   # admin/ ships in WarmReach Pro only
    ```

2.  **Python Test Environment**:
    ```bash
    cd tests/backend
    python3 -m venv .venv
    source .venv/bin/activate
    uv pip install -r requirements-test.lock
    cd ../..
    ```
    Install from `requirements-test.lock` (pinned + hashed), never from
    `requirements-test.txt` — that file is only the loose-range input used to
    regenerate the lock.

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
- **MiniStack** (port 4566) — DynamoDB, S3, SQS, Cognito
- **ministack-init** — Provisions all AWS resources on startup
- **mock-linkedin** (port 3333) — Simulated LinkedIn pages
- **client-backend** (port 3001) — Automation backend
- **frontend** (port 5173) — Vite dev server

### MiniStack

MiniStack provides local AWS services. The init script (`scripts/ministack/init-aws.sh`) creates:
- DynamoDB table with PK/SK and **GSI1 only**. The SAM template declares more
  — four indexes in WarmReach Pro, two in the community edition (see
  [ARCHITECTURE.md](ARCHITECTURE.md#global-secondary-indexes)). The
  consequence is concrete: **local integration tests cannot exercise a query
  that goes through any index other than GSI1.** Extending `init-aws.sh` is
  deliberately not done — one script cannot match two templates, and
  provisioning indexes no local test reads would be dead configuration that
  goes stale on the next template change
- S3 bucket for screenshots
- SQS queues with DLQ redrive policy
- Cognito user pool with test user (`testuser@example.com` / `TestPass123!`)

Run integration tests against MiniStack:
```bash
docker compose up ministack -d
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

### Fingerprint Inspection Tool

A standalone script launches a non-headless browser with the full anti-fingerprinting stack (stealth plugin, canvas/WebGL/audio noise, request interception, random user agent, system Chrome detection). Use it to manually inspect what LinkedIn sees.

```bash
cd client && node --import tsx linkedin-inspect.mjs
```

Disable individual layers for comparison testing:

```bash
PUPPETEER_STEALTH=false node --import tsx client/linkedin-inspect.mjs
PUPPETEER_FINGERPRINT_NOISE=false node --import tsx client/linkedin-inspect.mjs
```

Visit `bot.sannysoft.com` in the opened browser to verify stealth mitigations are active.

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

## Documentation

Lint the Markdown docs locally with markdownlint:

```bash
npm run lint:docs          # markdownlint over docs/**/*.md and *.md
npm run lint:docs:links    # lychee link check — only if lychee is installed locally
```

Both checks are blocking gates in CI via `.github/workflows/docs-lint.yml` (one
job runs markdownlint, the other runs lychee) — a PR with a Markdown-style error
or a broken link fails CI. Locally, `lint:docs` covers the markdownlint half;
link checking uses lychee, which ships as a standalone binary (not an npm
package), so `lint:docs:links` runs it only when it is on your `PATH` and
otherwise prints install instructions. The authoritative link check is the
SHA-pinned `lycheeverse/lychee-action` in CI.

Generate the API reference from source. typedoc covers the TypeScript components
(`frontend/`, `client/`, `admin/`); mkdocstrings covers the Python Lambda
shared-services layer. The output lands in `docs/api/` (gitignored — it is
generated in CI, not committed). The `.github/workflows/docs-api.yml` workflow
runs both generators on every relevant source change to prove they stay
buildable:

```bash
npm run docs:api          # both TS and Python
npm run docs:api:ts       # typedoc -> docs/api/ts/{frontend,client,admin}
npm run docs:api:py       # mkdocstrings -> docs/api/py
```

The Python generator uses `uvx` (no local install needed). Some shared-service
docstrings document parameters without type annotations; griffe emits warnings
for those, which are non-fatal — backfilling the annotations is a future task.

## Working with Sync Overlays

WarmReach Pro syncs one-way to the [community edition](https://github.com/HatmanStack/warmreach) via `.sync/sync.sh`. When modifying files, check whether they have a sync overlay:

1. Open `.sync/config.json` and search `overlay_mappings` for the file path
2. Three outcomes:
   - **File has an overlay** (`overlay_mappings` entry exists): Update BOTH the source file AND the corresponding overlay in `.sync/overlays/`
   - **File is excluded** (listed in `exclude_paths`): No overlay to update — the file never reaches the community repo
   - **File syncs directly** (not in either list): Changes flow automatically to the community repo via rsync

Common overlay patterns:
- Lambda handlers: community overlay strips billing/tier gating
- `monetization.py`: swapped for `monetization_stubs.py` (no-op)
- Frontend components: pro features stubbed out
- Docs: "Available in WarmReach Pro" notes added

Run `.sync/sync.sh --dry-run` to preview what would change in the community repo.

## Project Structure

-   `frontend/`: React/Vite frontend application
-   `client/`: Electron tray app + Node.js/Express backend for browser automation
-   `backend/`: AWS SAM infrastructure and Lambda functions
-   `tests/`: Unit, integration, and E2E tests
-   `docs/`: Project documentation
-   `scripts/`: Utility scripts for deployment and development
