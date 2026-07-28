# Deploying WarmReach Community Edition

This guide walks through deploying a fresh WarmReach stack from scratch. After the architecture redesign, all infrastructure lives in this repo — there is no separate control plane stack.

> **Note:** Billing, tier management, admin metrics (`AdminUserSub` parameter), and pro-only SAM parameters are available in WarmReach Pro. The community-edition SAM template keeps a pared-down parameter set; see `template.yaml` for the authoritative list.

## Prerequisites

- **AWS CLI** configured with appropriate credentials
- **SAM CLI** v1.100+
- **Node.js** 24 LTS
- **Python** 3.13+

## 0. Optional: the RAGStack API key as an SSM SecureString

This edition has one optional secret parameter. Without it the key arrives as a
plaintext Lambda environment variable, which is what the runtime warns about.

```bash
# Read the value from a file rather than passing it inline: a --value argument
# lands in shell history and is visible to any user who can run `ps` while the
# command runs.
aws ssm put-parameter \
  --name "/warmreach/prod/ragstack-api-key" \
  --type SecureString --value "file://ragstack-key.txt" \
  --tags Key=Project,Value=warmreach
rm ragstack-key.txt
```

Pass the resulting **ARN** as the `RagstackApiKeyArn` template parameter, never
the value; the functions fetch and cache it at runtime.

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
- OpenAI API key, stored as an SSM SecureString (optional; the LLM Lambda reads it at runtime by ARN, so the key itself is never a stack parameter)

It automatically runs `sam build && sam deploy`, captures outputs, and updates your `.env` file.

### Option B: Manual SAM Deployment

```bash
cd backend
sam build
sam deploy --guided
```

Key parameter prompts:

All 17 parameters this edition's template declares, in the order
`backend/template.yaml` declares them, so the two can be diffed top to
bottom. "Required" is operational, not a CloudFormation constraint.

| Parameter                 | Default       | Required    | Description                                                                                                                                                                                                                                                   |
| ------------------------- | ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Environment`             | `prod`        | yes         | `dev` or `prod`. `dev` adds the localhost CORS origins.                                                                                                                                                                                                       |
| `IncludeDevOrigins`       | `true`        | yes         | Allowlists `http://localhost:5173/5174` as CORS origins, but **only when `Environment=dev`**. It defaults to `true` and `Environment` defaults to `prod`, so an all-defaults deploy used to be a prod stack that trusted localhost; the template now requires both, so prod fails closed regardless of this value. |
| `ProductionOrigins`       | (blank)       | yes         | Comma-separated allowed origins for API Gateway CORS.                                                                                                                                                                                                         |
| `ProductionOrigin`        | (blank)       | yes         | Primary origin for S3 CORS.                                                                                                                                                                                                                                   |
| `OpenAIApiKeyArn`         | (blank)       | no          | SSM SecureString ARN — not the raw key. The LLM Lambda fetches it at runtime, so AI operations need it set.                                                                                                                                                   |
| `DeployRAGStack`          | `true`        | yes         | `true` for nested RAGStack, `false` to use an external endpoint.                                                                                                                                                                                              |
| `AdminEmail`              | (blank)       | conditional | Required when `DeployRAGStack=true`.                                                                                                                                                                                                                          |
| `RagstackGraphqlEndpoint` | (blank)       | conditional | External RAGStack GraphQL endpoint URL. Required when `DeployRAGStack=false` (see Option C); ignored when nested.                                                                                                                                             |
| `RagstackApiKey`          | (blank)       | conditional | External RAGStack API key (`NoEcho: true`). Required when `DeployRAGStack=false`. Prefer `RagstackApiKeyArn` below.                                                                                                                                           |
| `RagstackTemplateUrl`     | public S3 URL | no          | S3 URL of the packaged RAGStack CloudFormation template, used when `DeployRAGStack=true`.                                                                                                                                                                     |
| `ClientDownloadMacUrl`    | (blank)       | no          | macOS desktop client download URL (`https://` or `s3://bucket/key`). Blank renders "coming soon".                                                                                                                                                             |
| `ClientDownloadWinUrl`    | (blank)       | no          | Windows desktop client download URL. Same rules.                                                                                                                                                                                                              |
| `ClientDownloadLinuxUrl`  | (blank)       | no          | Linux desktop client download URL. Same rules.                                                                                                                                                                                                                |
| `ClientDownloadVersion`   | (blank)       | no          | Optional version label shown next to the download buttons.                                                                                                                                                                                                    |
| `ClientDownloadBucket`    | (blank)       | conditional | Bucket holding the desktop client binaries. Required only when a `ClientDownload*Url` uses `s3://`; the `client-downloads` Lambda's `s3:GetObject` grant is scoped to it.                                                                                     |
| `LogRetentionDays`        | `30`          | yes         | Retention on every Lambda log group. LinkedIn profile data, message bodies and email addresses flow through these handlers, so the CloudWatch default of Never Expire is indefinite PII retention. Restricted to the periods CloudWatch Logs accepts.         |
| `RagstackApiKeyArn`       | (blank)       | no          | SSM SecureString ARN holding the RAGStack API key. When set, no plaintext `RAGSTACK_API_KEY` is injected into any Lambda. Blank keeps the legacy plaintext env var, which logs a warning.                                                                     |

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

| Output                    | Used By                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `ApiUrl`                  | Frontend `VITE_API_GATEWAY_URL`, Client `API_GATEWAY_BASE_URL` |
| `UserPoolId`              | Frontend `VITE_COGNITO_USER_POOL_ID`                           |
| `UserPoolClientId`        | Frontend `VITE_COGNITO_USER_POOL_WEB_CLIENT_ID`                |
| `DynamoDBTableName`       | Client `DYNAMODB_TABLE`                                        |
| `WebSocketApiUrl`         | Frontend `VITE_WEBSOCKET_URL`                                  |
| `RAGStackGraphQLEndpoint` | Client `RAGSTACK_GRAPHQL_ENDPOINT` (if nested)                 |

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
  |     +-- POST /linkedin-actions -> linkedin-action-gate (action dispatch)
  |     +-- POST /edges -> edge-crud
  |     +-- POST /ragstack -> ragstack-ops
  |     +-- POST /analytics -> analytics-insights
  |     +-- GET/POST /dynamodb, /profiles -> dynamodb-api
  |     +-- POST /llm -> llm
  |     +-- GET /client-downloads -> client-downloads (public, no auth)
  |
  +-- DynamoDB (single table)
  |     +-- USER#{sub} -> settings, quotas, usage counters
  |     +-- WSCONN#{connId} -> WebSocket connection tracking
  |     +-- COMMAND#{cmdId} -> command item lifecycle (DynamoDB status field)
  |     +-- profiles, edges, etc.
  |
  +-- Electron Client (user's machine)
        +-- WebSocket connection to backend
        +-- Puppeteer browser automation
        +-- LinkedIn credentials (local only, never sent to backend)
```

## DynamoDB indexes

The table declares two global secondary indexes:

| Index  | Keys                          | Purpose                                                                                        |
| ------ | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `GSI1` | `GSI1PK` HASH / `GSI1SK` RANGE | General access patterns (profiles, edges, activity)                                            |
| `GSI3` | `GSI3PK` HASH / `GSI3SK` RANGE | Sparse reconciliation index. Always empty here — its only writer is a pro-only feature         |

It deliberately declares **no inverted `SK`/`PK` index**. WarmReach Pro carries
one to answer `SK = TIER#current` queries for its weekly digest and admin
dashboard; both of those Lambdas are pro-only, so the community edition has no
reader for such an index. Every item has an `SK`, so adding one would put a
second index entry on every single write to serve nothing.

That is why the "GSI2 -> GSI4 migration" runbook in the pro deployment guide has
no counterpart here: there is no index to migrate. If you add a feature that
needs to look items up by `SK`, add a new index with an `INCLUDE` projection over
just the attributes you read — not `ProjectionType: ALL`, which on an `SK`-keyed
index is a complete second copy of the table.

## Dead-letter queues

Two Lambdas are invoked asynchronously and so get an SQS dead-letter queue:

| Queue                                     | Catches failures from                                |
| ----------------------------------------- | ---------------------------------------------------- |
| `warmreach-llm-dlq-{env}`                 | `llm`, when invoked async for evidence re-assessment |
| `warmreach-research-reconciler-dlq-{env}` | `research-reconciler`, on its EventBridge schedule   |

An async invocation retries twice and is then discarded, so without these a
failed run leaves nothing behind to inspect. Messages are kept for 14 days.

Nothing watches these queues automatically in the community edition — check
them with `aws sqs receive-message` if work appears to have gone missing:

```bash
ENV=dev                          # the Environment you deployed with
REGION=${AWS_REGION:-us-west-2}

aws sqs get-queue-attributes --region "$REGION" \
  --queue-url "$(aws sqs get-queue-url --queue-name "warmreach-llm-dlq-$ENV" \
    --region "$REGION" --query QueueUrl --output text)" \
  --attribute-names ApproximateNumberOfMessages
```

## Cognito MFA is OPTIONAL, and that is a rollout decision

_Added 2026-07-27._ The user pool declares `MfaConfiguration: OPTIONAL` with
software-token MFA enabled. `OPTIONAL` means every user _can_ enrol a TOTP
authenticator and nobody _has to_.

This is deliberate. `ON` on an existing pool locks out every user who has not
yet enrolled — they cannot sign in to enrol. The safe sequence is deploy with
`OPTIONAL`, let users enrol, check `UserMFASettingList` via
`aws cognito-idp list-users --user-pool-id <id>`, and only then change the
template to `ON` and deploy again.

Note the value is `ON`, not `REQUIRED`: `MfaConfiguration` accepts only `OFF`,
`ON`, or `OPTIONAL`, and `ON` is the one that enforces MFA. Deploying
`REQUIRED` fails template validation.

**That last step is not in this repository.** Flipping it is an operator decision
that depends on your user base, and committing it would make the next
`sam deploy` lock people out.

## Upgrading an existing stack: explicit log groups

_Added 2026-07-27._ The template declares an explicit `AWS::Logs::LogGroup` per
function (12 of them) so `LogRetentionDays` applies to all of them. Before that,
Lambda created each group implicitly on first invocation.

**This is a hand action with no code counterpart.** CloudFormation cannot adopt a
log group it did not create, so on an existing stack the first deploy after this
change fails with `resource already exists` for every function that has ever run.
Either delete the pre-existing groups or import them, before deploying:

```bash
ENV=prod
aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/warmreach-" \
  --query "logGroups[?ends_with(logGroupName, '-$ENV')].logGroupName" --output text
```

Deleting discards the existing log history for those functions. A brand-new stack
needs neither — this section applies only to a stack that predates the change.

## Tearing Down

```bash
# Delete the SAM stack (includes all Lambda, DynamoDB, Cognito, API Gateway resources)
sam delete --stack-name <stack-name>
```

If RAGStack was deployed as a nested stack, it is deleted automatically with the parent. If deployed separately, delete it independently:

```bash
sam delete --stack-name <ragstack-stack-name>
```
