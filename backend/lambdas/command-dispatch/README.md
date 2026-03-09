# Command Dispatch Lambda

Command creation and dispatch to the Electron agent via WebSocket.

## Runtime

- Python 3.13
- Handler: `lambda_function.lambda_handler`
- Routes: `/commands`

## Operations

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/commands` | Create a command and dispatch to Electron agent via WebSocket |
| `GET` | `/commands/{commandId}` | Poll for command status |

## Rate Limiting

Per-user rate limiting: max 10 commands per minute (configurable via `COMMAND_RATE_LIMIT_MAX`).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMODB_TABLE_NAME` | Yes | DynamoDB table name |
| `WEBSOCKET_ENDPOINT` | Yes | WebSocket API endpoint for dispatching commands |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins |
| `COMMAND_RATE_LIMIT_MAX` | No | Max commands per user per minute (default: 10) |

## Authentication

JWT `sub` extracted from API Gateway authorizer claims. Returns 401 if no valid user_id found.
