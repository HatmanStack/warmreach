# Edge Processing Lambda

Connection edge management and RAGStack vector search/ingestion operations.

## Runtime

- Python 3.13
- Handler: `lambda_function.lambda_handler`
- Routes: `/edges`, `/ragstack`

## Edge Operations (`/edges`)

| Operation | Description |
|-----------|-------------|
| `get_connections_by_status` | Query edges by status (possible, sent, connected) |
| `upsert_status` | Create/update edge status for a profile |
| `add_message` | Append a message to an edge's message history |

## RAGStack Operations (`/ragstack`)

| Operation | Required Fields | Description |
|-----------|----------------|-------------|
| `search` | `query` | Semantic search across ingested profiles |
| `ingest` | `profileId`, `markdownContent` | Ingest profile markdown for vector search |
| `status` | `documentId` | Check ingestion status of a document |
| `scrape_start` | `profileId`, `cookies` | Start RAGStack web scrape of a LinkedIn profile |
| `scrape_status` | `jobId` | Check scrape job status |

## DynamoDB Schema

### User-to-Profile Edge
- **PK**: `USER#<user_id>`
- **SK**: `PROFILE#<profile_id_b64>`
- **GSI1PK**: `USER#<user_id>`
- **GSI1SK**: `STATUS#<status>#PROFILE#<profile_id_b64>`

### Profile-to-User Edge
- **PK**: `PROFILE#<profile_id_b64>`
- **SK**: `USER#<user_id>`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMODB_TABLE_NAME` | Yes | DynamoDB table name |
| `RAGSTACK_GRAPHQL_ENDPOINT` | No | RAGStack GraphQL endpoint for vector search |
| `RAGSTACK_API_KEY` | No | RAGStack API key |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins |

## Authentication

JWT `sub` extracted from API Gateway authorizer claims. Returns 401 if no valid user_id found.
