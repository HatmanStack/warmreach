# ADR-001: SSRF-safe URL validation (parse-only, no DNS resolution)

## Status

Accepted

## Context

`DynamoDBAPIService` accepts user-supplied URLs (profile links, avatar URLs) that are later fetched from Lambda. A full DNS-resolving validator is vulnerable to DNS-rebinding and time-of-check/time-of-use races, and also adds network latency to a hot path.

The cited site is `backend/lambdas/dynamodb-api/services/dynamodb_api_service.py:356`:

```python
def _is_safe_url(self, url: str) -> bool:
    """Validate URL is safe (HTTPS, non-private IP, valid hostname).

    Uses parse-only validation without DNS resolution (ADR-001).
    """
```

## Decision

Validate URLs by parsing alone. Reject on:

1. Non-HTTPS scheme.
1. Hostnames matching reserved suffixes (`.local`, `.internal`, `.localhost`) or the literal `localhost`.
1. Hostnames that parse as an IP in a private, link-local, or loopback range.

No DNS lookup is performed. Downstream fetchers treat the URL as untrusted regardless and apply their own timeouts and size caps.

## Consequences

- Validation is O(1) and deterministic, with no network dependency.
- An attacker who controls DNS cannot pivot a valid-at-parse hostname to a private IP after validation, because the fetcher does not rely on the validator's resolution.
- Legitimate hostnames that only resolve to public addresses via DNS but parse as IP-literals in private ranges are rejected. This is intentional.
- If a future feature needs DNS-aware validation (for example, allowlisting a specific corporate domain), it must be a separate validator gated behind a feature flag.
