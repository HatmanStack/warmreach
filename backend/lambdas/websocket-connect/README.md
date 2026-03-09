# WebSocket Lambda Functions

Three Lambda functions handle the WebSocket API lifecycle.

## websocket-connect (`$connect`)

Validates Cognito JWT from query string (`?token=`), extracts `sub` and `clientType`, enforces single-client-per-user per type, and stores the connection in DynamoDB.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMODB_TABLE_NAME` | Yes | DynamoDB table name |
| `COGNITO_USER_POOL_ID` | Yes | Cognito User Pool ID for JWT validation |
| `COGNITO_REGION` | No | Cognito region (default: `us-east-1`) |
| `WEBSOCKET_ENDPOINT` | No | WebSocket API endpoint |

## websocket-default (`$default`)

Routes incoming WebSocket messages to the appropriate handler or forwards to the Electron agent.

## websocket-disconnect (`$disconnect`)

Cleans up the connection record from DynamoDB on disconnect.

## Authentication

JWT token passed in the query string at `$connect` time. Subsequent messages use the authenticated connection ID.
