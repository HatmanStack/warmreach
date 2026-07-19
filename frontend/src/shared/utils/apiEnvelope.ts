/**
 * Normalize a possibly-wrapped API response body.
 *
 * Some backend integrations forward the raw Lambda-proxy envelope
 * (`{ statusCode, body }`, where `body` may be a JSON string) instead of
 * auto-unwrapping it. Callers that read `response.data` directly then silently
 * get `undefined` for every field — blanking analytics charts, reading a paid
 * subscription as "never subscribed", or losing a checkout URL.
 *
 * Pass `response.data` through this to always get the decoded body regardless
 * of which shape the endpoint returned.
 *
 * An error envelope (`statusCode >= 400`) is thrown rather than decoded as a
 * success value — otherwise a `{ statusCode: 500, body: '{"error":...}' }`
 * response would resolve as the success type with every field undefined,
 * silently masking the failure (e.g. reading a paid subscription as "none").
 */
export function unwrapEnvelope<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'statusCode' in raw && 'body' in raw) {
    const wrapped = raw as { statusCode: number; body: unknown };
    const body = typeof wrapped.body === 'string' ? JSON.parse(wrapped.body) : wrapped.body;
    if (typeof wrapped.statusCode === 'number' && wrapped.statusCode >= 400) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `Request failed with status ${wrapped.statusCode}`;
      throw new Error(message);
    }
    return body as T;
  }
  return raw as T;
}
