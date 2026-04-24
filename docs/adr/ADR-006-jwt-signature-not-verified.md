# ADR-006: JWT signature-not-verified tradeoff (client validates expiration + structure only)

## Status

Accepted

## Context

The Electron client holds a Cognito-issued JWT. It needs to decide whether to attempt a request or force a re-login, without shipping the Cognito JWKS into the desktop bundle or making a network call on every navigation.

The cited sites are `client/src/shared/utils/jwtValidator.integration.test.js:144,153`:

```javascript
// An attacker might try to extend the exp claim
// Since we don't verify signature, this would actually pass
// This is an accepted limitation per ADR-006
const manipulatedToken = createTestJwt({ sub: 'user-123', exp: currentTime + 86400 * 365 });

const result = validateJwt(manipulatedToken);

// This passes because we don't verify signature
// ADR-006 documents this as acceptable tradeoff
expect(result.valid).toBe(true);
```

## Decision

Client-side JWT validation checks structure (three base64url segments) and expiration (`exp` claim) only. It does not verify the signature. The server is the authoritative checkpoint; every protected API route verifies the signature against the Cognito JWKS.

## Consequences

- A user can manually forge a token that passes client validation. The forged token is immediately rejected by the backend API Gateway authorizer, so the only effect is a confusing UI state that resolves on the first real request.
- The client bundle avoids both the JWKS bytes and the JWKS fetch-and-cache plumbing.
- The integration test quoted above asserts this tradeoff so a future change that flips signature verification on without revisiting this ADR fails the suite.
- If the client ever needs to render trusted claims (roles, tier) before calling the backend, it must fetch them from a signed endpoint, not read them from the token.
