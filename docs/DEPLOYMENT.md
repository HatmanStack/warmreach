# Deploying WarmReach Community Edition

This guide walks through deploying a fresh WarmReach stack from scratch. After the architecture redesign, all infrastructure lives in this repo — there is no separate control plane stack.

> **Note:** Billing and tier management are available in WarmReach Pro.

## Prerequisites

- **AWS CLI** configured with appropriate credentials
- **SAM CLI** v1.100+
- **Node.js** 24 LTS
- **Python** 3.13+

## 1. Deploy the Backend

### Option A: Interactive Deployment Script (Recommended)

```bash
node scripts/deploy/deploy-sam.js
```

The script will prompt for:
- Stack name (e.g., `warmreach-prod`)
- Region (us-east-1 recommended for Bedrock access)
- Environment (`dev` or `prod`)
- RAGStack deployment mode (nested or external)
- OpenAI API key (optional)

It automatically runs `sam build && sam deploy`, captures outputs, and updates your `.env` file.

### Option B: Manual SAM Deployment

```bash
cd backend
sam build
sam deploy --guided
```

Key parameter prompts:

| Parameter | Value | Notes |
|-----------|-------|-------|
| `Environment` | `prod` | `dev` includes localhost CORS origins |
| `IncludeDevOrigins` | `false` | Set `true` for dev stacks |
| `ProductionOrigins` | `https://app.warmreach.com` | Comma-separated allowed origins |
| `ProductionOrigin` | `https://app.warmreach.com` | Primary origin for S3 CORS |
| `OpenAIApiKey` | your key | For LLM Lambda |
| `BedrockModelId` | `us.meta.llama3-2-90b-instruct-v1:0` | Default works |
| `DeployRAGStack` | `true` or `false` | Nested RAGStack or use external |
| `AdminEmail` | your email | Required if nested RAGStack |

Deployment takes 5-20 minutes depending on whether RAGStack is nested.

### Option C: Deploy RAGStack Separately First

If you want to manage RAGStack independently:

```bash
node scripts/deploy/deploy-ragstack.js
```

This clones RAGStack-Lambda, deploys it, and saves outputs to `.env.ragstack`. Then deploy the main stack with `DeployRAGStack=false` and provide the RAGStack endpoint/key.

## 2. Capture Stack Outputs

If you used the interactive script, `.env` is already updated. Otherwise:

```bash
bash scripts/deploy/get-env-vars.sh <stack-name> --update-env
```

Or manually retrieve outputs:

```bash
aws cloudformation describe-stacks --stack-name <stack-name> \
  --query 'Stacks[0].Outputs' --output table
```

Key outputs you need:

| Output | Used By |
|--------|---------|
| `ApiUrl` | Frontend `VITE_API_GATEWAY_URL`, Client `API_GATEWAY_BASE_URL` |
| `UserPoolId` | Frontend `VITE_COGNITO_USER_POOL_ID` |
| `UserPoolClientId` | Frontend `VITE_COGNITO_USER_POOL_WEB_CLIENT_ID` |
| `DynamoDBTableName` | Client `DYNAMODB_TABLE` |
| `WebSocketApiUrl` | Frontend `VITE_WEBSOCKET_URL` |
| `RAGStackGraphQLEndpoint` | Client `RAGSTACK_GRAPHQL_ENDPOINT` (if nested) |

## 3. Create First Cognito User

```bash
POOL_ID="<UserPoolId from outputs>"

aws cognito-idp admin-create-user \
  --user-pool-id $POOL_ID \
  --username "admin@example.com" \
  --user-attributes Name=email,Value=admin@example.com \
  --temporary-password "TempPass123!"

aws cognito-idp admin-set-user-password \
  --user-pool-id $POOL_ID \
  --username "admin@example.com" \
  --password "YourPermanentPassword!" \
  --permanent
```

## 4. Configure Frontend

Update frontend `.env` (or set in your deployment pipeline):

```env
VITE_API_GATEWAY_URL=https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod
VITE_AWS_REGION=us-east-1
VITE_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
VITE_COGNITO_USER_POOL_WEB_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_WEBSOCKET_URL=wss://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod
```

Build and deploy the frontend:

```bash
cd frontend && npm run build
# Deploy frontend/dist/ to S3 + CloudFront (or your hosting provider)
```

## 5. Verify WebSocket API

Test the WebSocket connection with a valid Cognito JWT:

```bash
# Get a JWT token
TOKEN=$(aws cognito-idp admin-initiate-auth \
  --user-pool-id $POOL_ID \
  --client-id <UserPoolClientId> \
  --auth-flow ADMIN_NO_SRP_AUTH \
  --auth-parameters USERNAME=admin@example.com,PASSWORD=YourPermanentPassword! \
  --query 'AuthenticationResult.AccessToken' --output text)

# Connect via wscat
npx wscat -c "wss://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod?token=$TOKEN"

# Send a heartbeat (should echo back)
> {"action": "heartbeat"}
```

## 6. Generate Encryption Keys

Generate Sealbox key pairs for credential encryption between frontend and client:

```bash
node scripts/dev-tools/generate-device-keypair.js
```

Set the public key in frontend config:
```env
VITE_CRED_SEALBOX_PUBLIC_KEY_B64=<base64 public key>
```

Set the private key path in client config:
```env
CRED_SEALBOX_PRIVATE_KEY_PATH=<path to private key>
```

## 7. Set Up Electron Client

The Electron tray app connects to the backend via WebSocket and executes Puppeteer commands locally.

```bash
cd client
npm install
```

Configure the WebSocket URL either via:
- Environment variable: `WARMREACH_WS_URL=wss://...`
- Or through the Settings window in the tray menu after first launch

Start in dev mode:
```bash
npm run electron:dev
```

Package for distribution:
```bash
npm run electron:build
```

See `client/electron-builder.yml` for platform-specific build configuration. Code signing requires `MAC_CERT_P12`/`WIN_CERT_PFX` secrets.

## Stack Architecture

After deployment, the stack consists of:

```
Users
  |
  +-- Frontend (S3 + CloudFront)
  |     +-- HTTP API -> Lambda (Cognito JWT auth)
  |     +-- WebSocket API -> Lambda (JWT in query string)
  |
  +-- WebSocket API Gateway
  |     +-- $connect -> websocket-connect (JWT validation, connection tracking)
  |     +-- $disconnect -> websocket-disconnect (cleanup)
  |     +-- $default -> websocket-default (message routing)
  |
  +-- HTTP API Gateway
  |     +-- POST/GET /commands -> command-dispatch (create + dispatch commands)
  |     +-- POST /edges, /ragstack -> edge-processing
  |     +-- GET/POST /dynamodb, /profiles -> dynamodb-api
  |     +-- POST /llm -> llm
  |
  +-- DynamoDB (single table)
  |     +-- USER#{sub} -> settings, quotas, usage counters
  |     +-- WSCONN#{connId} -> WebSocket connection tracking
  |     +-- COMMAND#{cmdId} -> command state machine
  |     +-- profiles, edges, etc.
  |
  +-- Electron Client (user's machine)
        +-- WebSocket connection to backend
        +-- Puppeteer browser automation
        +-- LinkedIn credentials (local only, never sent to backend)
```

## Tearing Down

```bash
# Delete the SAM stack (includes all Lambda, DynamoDB, Cognito, API Gateway resources)
sam delete --stack-name <stack-name>
```

If RAGStack was deployed as a nested stack, it is deleted automatically with the parent. If deployed separately, delete it independently:
```bash
sam delete --stack-name <ragstack-stack-name>
```
