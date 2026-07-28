<!-- Community overlay of docs/TROUBLESHOOTING.md. Two sections diverge because
     the two editions genuinely differ: the runbooks for surfaces only WarmReach
     Pro ships are dropped, and the dead-letter-queue entry is written against
     this edition's template, which declares two queues and no alarm stack.
     Everything else is shared — keep the two files in step. -->

# Troubleshooting Guide

This guide covers common issues encountered during development and deployment of the WarmReach tool.

## Client & LinkedIn Issues

### Authentication Failures
-   **Symptom**: "Login failed" or "Security checkpoint encountered."
-   **Solution**:
    -   Increase `LOGIN_SECURITY_TIMEOUT` in `.env` to allow more time for manual intervention if a CAPTCHA appears.
    -   Ensure `VITE_CRED_SEALBOX_PUBLIC_KEY_B64` in the frontend build matches the
        device keypair the client holds — both come from
        `scripts/dev-tools/generate-device-keypair.js`. There is no backend half to
        match: the private key never leaves the device.
    -   Check if LinkedIn has flagged the IP. Try running in non-headless mode (`HEADLESS=false`) to see what's happening.

### Element Not Found
-   **Symptom**: Puppeteer fails to find a button or input field.
-   **Solution**:
    -   LinkedIn frequently updates its DOM. Check if the selectors in `client/src/domains/` need updating.
    -   Increase `ELEMENT_WAIT_TIMEOUT` in `.env`.
    -   Use `SCREENSHOT_ON_ERROR=true` to see the page state at the time of failure.

### Session Expired
-   **Symptom**: Automation stops working after a period of time.
-   **What the client already does**: a recoverable failure — login failure, timeout, CAPTCHA, checkpoint, rate limit, navigation failure — is retried **in process**. The controller raises `HealingRequiredError`, the run-with-healing loop closes the browser and re-runs the phase from its resume state with a fresh one, up to `MAX_HEALING_ATTEMPTS` (3). Past that the run fails with a real error naming the phase and reason. Look for `Profile-init healing — resuming in-process` in the logs to confirm it tried.
-   **Solution** once it has exhausted those attempts:
    -   Read the final error: it carries the last `healPhase` and `healReason`. That says which step LinkedIn refused, and retrying will not change it.
    -   Re-run with `HEADLESS=false` to see the page. A retry loop cannot clear a CAPTCHA or a security checkpoint; that needs a person. Set `LOGIN_SECURITY_TIMEOUT` (default `0`) to a non-zero millisecond value to hold the browser open long enough to do it by hand.
    -   Confirm the stored LinkedIn credentials are still valid — a password change or a locked account surfaces here as a repeated login failure.
    -   `LINKEDIN_SESSION_TIMEOUT` (default 1 hour) is **not** LinkedIn's session lifetime. It caps how long this client reuses one local browser session before its health check declares it stale and rebuilds it. Raising it makes the client hold a browser open longer; it does not extend anything on LinkedIn's side.

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
    -   Add your frontend's URL to the `ProductionOrigins` template parameter and
        redeploy. `ALLOWED_ORIGINS` on the Lambda is derived from it (plus
        localhost only when `IncludeDevOrigins` is true AND `Environment` is
        `dev`) — setting it directly is overwritten on the next deploy, and
        `FRONTEND_URLS` is read by nothing.
    -   Check the `API Gateway` configuration in the AWS Console to ensure CORS is enabled for the relevant resources.

## Environment Parity (dev vs prod)

The SAM template exposes two coupled parameters that change CORS and logging behaviour:

| Parameter | `dev` | `prod` | Effect |
|-----------|-------|--------|--------|
| `Environment` | `dev` | `prod` | Propagated as the `ENVIRONMENT` Lambda env var. |
| `IncludeDevOrigins` | `true` | ignored | Adds `http://localhost:5173` and `http://localhost:5174` to the API Gateway CORS origin list on top of `ProductionOrigins`. Has effect **only** when `Environment=dev`; a `prod` stack ignores it and never allowlists localhost. |

Guidelines:

- Production stacks set `Environment=prod` and `IncludeDevOrigins=false`. Leaving `IncludeDevOrigins=true` in prod is a credential-leak vector if a developer's machine is compromised.
- Dev stacks set `Environment=dev` and `IncludeDevOrigins=true` to unblock local frontend development against the deployed API.
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

### Work Disappeared from an Async Lambda

- **Symptom**: a deep-research job or a scheduled reconcile produced nothing and
  the logs stop mid-run.
- **Likely Cause**: an asynchronous invocation retries twice and is then
  discarded. This edition attaches a dead-letter queue to the two Lambdas that
  are invoked asynchronously — `llm` and `research-reconciler` — so the failed
  payload survives even though the run did not.
- **Fix**: this edition ships **no CloudWatch alarms**, so nothing tells you a
  queue is non-empty; check it yourself. See
  [Dead-letter queues](DEPLOYMENT.md#dead-letter-queues) in the deployment guide
  for the queue names and the `aws sqs` command.

## `COMMAND_TIMEOUT` or `COMMAND_OUTCOME_UNKNOWN` from the desktop client

-   **Symptom**: the web app reports a command failed with code
    one of two codes. `COMMAND_TIMEOUT` with a message ending `waited Nms for
    the browser queue and was dropped; it never started`, or
    `COMMAND_OUTCOME_UNKNOWN` with one ending `exceeded its Nms wall-clock
    budget and is still running`.
-   **What it means**: every command carries a wall-clock deadline
    (`client/src/transport/commandRouter.ts`) — 3 minutes for a single
    interaction, 15 for a search, 60 for a full profile import. The two messages
    are different outcomes and the distinction matters:
    -   **`COMMAND_TIMEOUT` (dropped)** — the command never ran. Safe to retry.
    -   **`COMMAND_OUTCOME_UNKNOWN` (exceeded)** — the command was already
        running when the budget expired.
        A Puppeteer batch cannot be aborted mid-navigation, so it keeps running
        to completion in the background. Retrying may perform the action twice.
-   **Most common cause**: a 60-minute `linkedin:profile-init` holding the
    single browser slot. Interactions dispatched during an import are dropped at
    their own 3-minute budget rather than executing an hour later. That is
    deliberate — reporting an action as failed and then performing it is worse.
-   **Solution**: wait for the import to finish, then retry. If it happens with
    no import running, check the tray status for a stalled browser session.

## General Development

### Missing Environment Variables
-   **Symptom**: Application crashes or behaves unexpectedly.
-   **Solution**:
    -   Run `bash scripts/deploy/get-env-vars.sh <stack-name> --update-env` to sync the SAM-output-backed vars (see [Automated Configuration](CONFIGURATION.md#automated-configuration) for the exact list). It does not populate `VITE_COGNITO_IDENTITY_POOL_ID` or RAGStack credentials.
    -   Compare your `.env` with `.env.example` and set any remaining values manually.
