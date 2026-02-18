# DynamoDB API Lambda

User settings, profile CRUD, tier management, and Stripe billing.

## Runtime

- Python 3.13
- Handler: `lambda_function.lambda_handler`
- Routes: `/dynamodb`, `/profiles`

## `/dynamodb` Route

### GET (query)

| Query Param | Description |
|-------------|-------------|
| (none) | Returns authenticated user's settings |
| `profileId` | Returns profile metadata for given LinkedIn profile (no auth required) |

### POST (operations)

| Operation | Description |
|-----------|-------------|
| `create` | Create a bad-contact profile entry |
| `update_user_settings` | Update user settings (linkedin_credentials, preferences) |
| `update_profile_picture` | Update user profile picture |
| `get_tier_info` | Get tier, feature flags, quotas, and rate limits for the user |
| `create_checkout_session` | Create a Stripe checkout session (requires `priceId`, `successUrl`, `cancelUrl`) |

## `/profiles` Route

| Method | Description |
|--------|-------------|
| `GET` | Get user profile data |
| `POST` | Update user settings (operation defaults to `update_user_settings`) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMODB_TABLE_NAME` | Yes | DynamoDB table name |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins (default: `http://localhost:5173`) |

## Authentication

JWT `sub` extracted from API Gateway authorizer claims. GET with `profileId` query param is allowed without auth (public profile lookup).
