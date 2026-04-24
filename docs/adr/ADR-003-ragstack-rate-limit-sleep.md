# ADR-003: RAGStack rate-limit sleep strategy (synchronous `time.sleep` in Lambda)

## Status

Accepted

## Context

RAGStack GraphQL calls and S3 uploads via presigned URL both need backoff-on-retry. The alternatives are Step Functions (async wait state) or synchronous `time.sleep` inside the Lambda. Step Functions adds a deploy-time dependency and a second invocation for a wait that is almost always sub-second.

The cited sites are:

- `backend/lambdas/shared/python/shared_services/ragstack_client.py:207`

  ```python
  # WARNING: time.sleep() blocks the Lambda execution thread. See ADR-003.
  # Exponential backoff before retry
  if attempt < self.max_retries - 1:
      delay = self.retry_delay * (2**attempt)
      time.sleep(delay)
  ```

- `backend/lambdas/shared/python/shared_services/ingestion_service.py:184` and `:237` — same pattern for S3 upload retries, with the docstring noting `Max block time: ~0.9 seconds`.

## Decision

Use synchronous `time.sleep` for backoff when the bounded maximum block time is under one second. Each call site must document the maximum block time in a comment or docstring. Any operation whose bounded block exceeds one second must be moved to Step Functions.

## Consequences

- Lambda billing clock runs during the sleep. This is acceptable at the ~0.9 s ceiling but becomes expensive at higher backoff counts.
- The blocking nature is explicitly flagged in every call site so future contributors cannot introduce unbounded `time.sleep` calls under this ADR.
- If RAGStack tightens its rate limits such that the required block exceeds one second, this ADR is superseded by a Step Functions design.
