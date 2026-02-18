# Mock LinkedIn Server

Local server that mimics LinkedIn's page structure for testing client automation without hitting the real site.

## Quick Start

```bash
cd mock-linkedin
npm install
npm start
# Server runs at http://localhost:3333
```

## Capturing Real LinkedIn Pages

For DOM-accurate testing, save real LinkedIn pages:

### Step 1: Save as MHTML (captures everything)
1. Open Chrome, navigate to the LinkedIn page
2. Press `Ctrl+S` (or `Cmd+S` on Mac)
3. Select "Webpage, Single File (.mhtml)"
4. Save to a temp location

### Step 2: Extract to HTML
1. Open the saved .mhtml file in Chrome
2. Press `Ctrl+S` again
3. Select "Webpage, HTML Only"
4. Save to `mock-linkedin/pages/` with these names:

| Page | Filename | LinkedIn URL |
|------|----------|--------------|
| Login | `login.html` | linkedin.com/login |
| Feed | `feed.html` | linkedin.com/feed/ |
| Your Profile | `profile.html` | linkedin.com/in/your-id/ |
| Messaging | `messaging.html` | linkedin.com/messaging/ |
| Search Results | `search-results.html` | linkedin.com/search/results/people/?keywords=test |
| Connections | `connections.html` | linkedin.com/mynetwork/invite-connect/connections/ |
| Received Invites | `invitations.html` | linkedin.com/mynetwork/invitation-manager/ |
| Sent Invites | `sent-invitations.html` | linkedin.com/mynetwork/invitation-manager/sent/ |
| Activity | `activity.html` | linkedin.com/in/someone/recent-activity/all/ |

### Step 3: (Optional) Clean up HTML
The server auto-rewrites `linkedin.com` URLs to `localhost:3333`, but you may want to:
- Remove tracking scripts
- Simplify heavy CSS
- Add `{{variable}}` placeholders for dynamic content

## Architecture

```
mock-linkedin/
├── server.js           # Express server with all routes
├── pages/              # Your saved HTML files go here
│   ├── login.html
│   ├── feed.html
│   ├── profile.html
│   └── ...
├── data/
│   └── mock-data.json  # Seed data (connections, invitations, etc.)
└── public/             # Static assets (CSS, images)
```

## Routes Supported

All routes match real LinkedIn URLs:

| Route | Description |
|-------|-------------|
| `GET /login` | Login page |
| `POST /uas/login-submit` | Login form handler |
| `GET /feed/` | Home feed |
| `GET /in/:profileId/` | Profile page |
| `GET /in/:profileId/recent-activity/:type/` | Activity pages |
| `GET /in/:profileId/overlay/about-this-profile/` | About modal |
| `GET /search/results/people/` | Search results |
| `GET /messaging/` | Messaging inbox |
| `GET /messaging/thread/new` | New message compose |
| `GET /mynetwork/invite-connect/connections/` | Your connections |
| `GET /mynetwork/invitation-manager/received/` | Received invitations |
| `GET /mynetwork/invitation-manager/sent/` | Sent invitations |
| `GET /health` | Health check |
| `POST /ragstack` | RAGStack proxy (search, ingest, status, scrape) |
| `GET /profiles` | Mock DynamoDB profiles query |
| `POST /profiles` | Mock DynamoDB profiles operations |
| `POST /edges` | Mock DynamoDB edge operations |

## API Endpoints (for testing)

```bash
# Send connection request
curl -X POST http://localhost:3333/api/connect \
  -H "Content-Type: application/json" \
  -d '{"profileId": "john-doe", "message": "Hi!"}'

# Send message
curl -X POST http://localhost:3333/api/message \
  -H "Content-Type: application/json" \
  -d '{"recipientId": "john-doe", "content": "Hello!"}'

# Create post
curl -X POST http://localhost:3333/api/post \
  -H "Content-Type: application/json" \
  -d '{"content": "Test post content"}'

# View current state
curl http://localhost:3333/api/state

# Reset state
curl -X POST http://localhost:3333/api/reset
```

## Connecting to Puppeteer Backend

Update your client backend to point to the mock server:

```bash
# In client/.env or environment
LINKEDIN_BASE_URL=http://localhost:3333
```

Or modify the client code to use a configurable base URL.

## Placeholder Pages

If you haven't saved real HTML yet, the server generates placeholder pages with the correct DOM selectors that your client code expects:

- `data-test-id="*"` attributes
- `aria-label="*"` attributes
- Key class names (`.scaffold-layout`, `.global-nav`, etc.)
- Form inputs with correct IDs

These placeholders let you test basic flow immediately.

## Adding Custom Mock Users

Edit `data/mock-data.json`:

```json
{
  "connections": [
    {
      "profileId": "custom-user-123",
      "name": "Custom User",
      "headline": "Job Title at Company",
      "isConnected": true,
      "connectionDegree": "1st"
    }
  ]
}
```

Restart the server to load new data.
