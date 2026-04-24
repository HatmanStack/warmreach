# ADR-004: SSM-backed secret TTL cache (OpenAI API key)

## Status

Accepted

## Context

The `llm` Lambda needs the OpenAI API key on every invocation. Reading the key from SSM Parameter Store on every cold start adds ~50 ms and a per-invocation SSM API call if not cached. Environment-variable injection is rejected because the key must be rotatable without a redeploy.

The cited site is `backend/lambdas/llm/lambda_function.py:27`:

```python
# SSM-backed OpenAI API key with TTL cache (ADR-004)
_openai_secret = SSMCachedSecret(os.environ.get('OPENAI_API_KEY_ARN', ''))
```

## Decision

Wrap SSM SecureString reads in `SSMCachedSecret` (see `shared_services/ssm_cache.py`). The cache holds the decrypted value at module scope for the duration of the Lambda execution environment, with a TTL so a rotated key is picked up within the TTL window without a forced redeploy.

## Consequences

- Warm invocations pay zero SSM calls. Cold invocations pay one.
- Key rotation propagates within the TTL. Operators who require immediate rotation must bounce the execution environment (touch the function configuration).
- The key is held in Lambda memory for the cache window. This is already true of environment variables and is acceptable given the execution environment isolation.
- Any additional secrets added to the `llm` Lambda must flow through the same `SSMCachedSecret` wrapper to keep the invariant uniform.
