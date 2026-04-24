# Troubleshooting Guide

This guide covers common issues encountered during development and deployment of the WarmReach tool.

## Client & LinkedIn Issues

### Authentication Failures
-   **Symptom**: "Login failed" or "Security checkpoint encountered."
-   **Solution**:
    -   Increase `LOGIN_SECURITY_TIMEOUT` in `.env` to allow more time for manual intervention if a CAPTCHA appears.
    -   Ensure your `VITE_CRED_SEALBOX_PUBLIC_KEY_B64` matches the keypair on the backend.
    -   Check if LinkedIn has flagged the IP. Try running in non-headless mode (`HEADLESS=false`) to see what's happening.

### Element Not Found
-   **Symptom**: Puppeteer fails to find a button or input field.
-   **Solution**:
    -   LinkedIn frequently updates its DOM. Check if the selectors in `client/src/domains/` need updating.
    -   Increase `ELEMENT_WAIT_TIMEOUT` in `.env`.
    -   Use `SCREENSHOT_ON_ERROR=true` to see the page state at the time of failure.

### Session Expired
-   **Symptom**: Automation stops working after a period of time.
-   **Solution**:
    -   LinkedIn sessions eventually expire. The "Heal & Restore" system should handle this, but you may need to re-authenticate manually if the session cannot be recovered.
    -   Adjust `LINKEDIN_SESSION_TIMEOUT` in `.env`.

## AWS & Deployment Issues

### SAM Build Failures
-   **Symptom**: `sam build` fails with dependency errors.
-   **Solution**:
    -   Ensure you have the correct Python version (3.13) installed.
    -   Check for syntax errors in `backend/template.yaml`.
    -   Clear the `.aws-sam` directory and try again.

### Lambda Permission Denied
-   **Symptom**: 403 Forbidden or 500 Internal Server Error when calling API.
-   **Solution**:
    -   Check CloudWatch Logs for the specific Lambda function.
    -   Verify that the IAM roles defined in `template.yaml` have the necessary permissions for DynamoDB, S3, and Bedrock/OpenAI.

### CORS Errors
-   **Symptom**: Frontend cannot communicate with the backend API.
-   **Solution**:
    -   Ensure `FRONTEND_URLS` in `.env` (or `ALLOWED_ORIGINS` in Lambda) includes your frontend's URL.
    -   Check the `API Gateway` configuration in the AWS Console to ensure CORS is enabled for the relevant resources.

## Admin Dashboard

### Admin Login Loop

- **Symptom**: Admin dashboard repeatedly redirects to the Cognito hosted UI after entering credentials.
- **Likely Cause**: `admin/.env` Cognito values drift from the SAM-deployed User Pool (see [Cognito Configuration Parity](CONFIGURATION.md#cognito-configuration-parity)).
- **Fix**: re-run `bash scripts/deploy/get-env-vars.sh <stack-name> --update-env`, then copy `VITE_COGNITO_USER_POOL_ID` and `VITE_COGNITO_USER_POOL_WEB_CLIENT_ID` from root `.env` into `admin/.env`. Rebuild with `npm run build:admin`.

### Permission Denied on `/admin/metrics`

- **Symptom**: HTTP 403 from `/admin/metrics`; admin UI shows an empty dashboard.
- **Likely Cause**: the authenticated Cognito `sub` does not match the `ADMIN_USER_SUB` env var on the `admin-metrics` Lambda.
- **Fix**: retrieve the `sub` claim from the JWT (`aws cognito-idp admin-get-user --user-pool-id $POOL_ID --username <email>`), then redeploy with `AdminUserSub=<sub>` or update the Lambda env directly.

### Metrics Endpoint 5xx

- **Symptom**: HTTP 500 from `/admin/metrics`; log line includes `ResourceNotFoundException` or CloudWatch `GetMetricData` errors.
- **Likely Cause**: `HTTP_API_ID` or `STACK_NAME` env var missing on `admin-metrics`, or IAM role lacks `cloudwatch:GetMetricData`.
- **Fix**: confirm stack outputs populated the Lambda env and that the `admin-metrics` IAM role includes CloudWatch read and DynamoDB scan permissions as defined in `backend/template.yaml`.

## Environment Parity (dev vs prod)

The SAM template exposes two coupled parameters that change CORS and logging behaviour:

| Parameter | `dev` | `prod` | Effect |
|-----------|-------|--------|--------|
| `Environment` | `dev` | `prod` | Propagated as the `ENVIRONMENT` Lambda env var (admin-metrics branches on it for metric-scope logging). |
| `IncludeDevOrigins` | `true` | `false` | When `true`, adds `http://localhost:5173` and `http://localhost:5174` to the API Gateway CORS origin list on top of `ProductionOrigins`. |

Guidelines:

- Production stacks set `Environment=prod` and `IncludeDevOrigins=false`. Leaving `IncludeDevOrigins=true` in prod is a credential-leak vector if a developer's machine is compromised.
- Dev stacks set `Environment=dev` and `IncludeDevOrigins=true` to unblock local frontend/admin development against the deployed API.
- `ProductionOrigins` is always required (comma-separated list). It is the allowlist the browser contract is enforced against.

## WebSocket

The `websocket-connect` Lambda validates Cognito JWTs and tracks connections in DynamoDB. All six failure paths surface as non-2xx responses from API Gateway's `$connect` route; inspect CloudWatch Logs for the `websocket-connect` function first.

### Connect Timeout

- **Symptom**: client reports `wscat` hangs then exits; no `WSCONN#{connId}` item appears in DynamoDB.
- **Likely Cause**: network path to `wss://<api>.execute-api.<region>.amazonaws.com` blocked, or the Lambda is cold-starting past the 10s handshake budget.
- **Fix**: retry; if persistent, raise `ReservedConcurrentExecutions` via the SAM parameters table or check VPC/SG rules on the client host.

### Token Validation Failure

- **Symptom**: HTTP 401 on `$connect`; log line `JWT validation failed` or `JWT missing kid in header`.
- **Likely Cause**: expired token, wrong client ID audience, or token signed by a different User Pool.
- **Fix**: confirm `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` on the Lambda match the pool the token was issued against. Re-authenticate to get a fresh token.

### Endpoint Unreachable (PyJWT Missing)

- **Symptom**: HTTP 500 on `$connect`; log line `PyJWT not installed - JWT validation will fail`.
- **Likely Cause**: the Lambda layer or requirements did not include `PyJWT[crypto]==2.9.0`.
- **Fix**: rebuild with `sam build` after confirming the requirement is pinned, then redeploy.

### JWKS Fetch Failure

- **Symptom**: HTTP 503 on `$connect`; log line `JWKS fetch failed and no usable cache available`.
- **Likely Cause**: transient network failure reaching Cognito's JWKS URL on a cold invocation with no cache, or the TTL and stale-grace window have both elapsed.
- **Fix**: retry. The Lambda serves a stale JWKS cache within the grace window, so persistent failures indicate Cognito reachability from the Lambda VPC. Verify egress routes.

### Malformed Connect Body

- **Symptom**: HTTP 400 on `$connect` or on `$default` message routing.
- **Likely Cause**: missing `token` query parameter on `$connect`, or non-JSON payload on `$default`.
- **Fix**: connect with `wss://...?token=<jwt>`. Messages must be JSON with an `action` field (e.g., `{"action": "heartbeat"}`).

### DLQ Alarm Fired

- **Symptom**: CloudWatch alarm `websocket-*-dlq-not-empty` transitions to `ALARM`.
- **Likely Cause**: async-invoked WebSocket Lambda (disconnect or default) failed after retries and the event landed in the SQS DLQ.
- **Fix**: follow the DLQ alarm runbook introduced in Phase 4 (`docs/plans/2026-04-23-audit-warmreach-pro/Phase-4.md`, DLQ task). Inspect the DLQ message body, reproduce locally, redrive after fix.

## General Development

### Missing Environment Variables
-   **Symptom**: Application crashes or behaves unexpectedly.
-   **Solution**:
    -   Run `bash scripts/deploy/get-env-vars.sh <stack-name> --update-env` to ensure your `.env` is up to date with AWS resources.
    -   Compare your `.env` with `.env.example`.
