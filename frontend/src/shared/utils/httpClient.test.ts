import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { httpClient } from './httpClient';
import { server } from '@/test-utils';
import { http, HttpResponse } from 'msw';

vi.mock('@/features/auth', () => ({
  CognitoAuthService: {
    getCurrentUserToken: vi.fn().mockResolvedValue('mock-token'),
  },
}));

describe('HttpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should add auth header to requests', async () => {
    let capturedToken = '';
    server.use(
      http.get('*/test-auth', ({ request }) => {
        capturedToken = request.headers.get('Authorization') || '';
        return HttpResponse.json({ success: true, data: 'ok' });
      })
    );

    await httpClient.get('test-auth');
    expect(capturedToken).toBe('Bearer mock-token');
  });

  it('should unwrap successful lambda response', async () => {
    server.use(
      http.post('*/edges', () => {
        return HttpResponse.json({
          statusCode: 200,
          body: JSON.stringify({ result: 'success' }),
        });
      })
    );

    const result = await httpClient.makeRequest('edges', 'op');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ result: 'success' });
  });

  it('should handle lambda error response', async () => {
    server.use(
      http.post('*/edges', () => {
        return HttpResponse.json({
          statusCode: 400,
          body: JSON.stringify({ error: 'Bad request', code: 'BAD_REQ' }),
        });
      })
    );

    const result = await httpClient.makeRequest('edges', 'op');
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Bad request');
    expect(result.error?.status).toBe(400);
  });

  it('parses the structured { error: { code, message, details } } shape', async () => {
    server.use(
      http.post('*/edges', () => {
        return HttpResponse.json({
          statusCode: 422,
          body: JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Field required',
              details: { field: 'name' },
            },
          }),
        });
      })
    );

    const result = await httpClient.makeRequest('edges', 'op');
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Field required');
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.status).toBe(422);
  });

  it('should retry on retryable errors', async () => {
    let attempts = 0;
    server.use(
      http.get('*/retry', () => {
        attempts++;
        if (attempts < 2) {
          return new HttpResponse(null, { status: 503 }); // Retryable
        }
        return HttpResponse.json({ data: 'success' });
      })
    );

    // Mock sleep to speed up test
    // @ts-expect-error - spying on private sleep
    vi.spyOn(httpClient, 'sleep').mockResolvedValue(undefined);

    const result = await httpClient.get('retry');
    expect(result.success).toBe(true);
    expect(attempts).toBe(2);
  });

  it('should not retry on non-retryable errors', async () => {
    let attempts = 0;
    server.use(
      http.get('*/no-retry', () => {
        attempts++;
        return new HttpResponse(null, { status: 404 }); // Not retryable
      })
    );

    const result = await httpClient.get('no-retry');
    expect(result.success).toBe(false);
    expect(attempts).toBe(1);
  });

  it('should retry on retryable errors and eventually fail', async () => {
    let attempts = 0;
    server.use(
      http.get('*/max-retry', () => {
        attempts++;
        return new HttpResponse(null, { status: 503 }); // Always retryable
      })
    );

    // Speed up test by mocking sleep
    // @ts-expect-error - spying on private sleep
    const sleepSpy = vi.spyOn(httpClient, 'sleep').mockResolvedValue(undefined);

    const result = await httpClient.get('max-retry');

    expect(result.success).toBe(false);
    expect(attempts).toBe(3); // default maxRetries is 3
    expect(result.error?.message).toContain('HTTP 503 error');

    sleepSpy.mockRestore();
  });

  it('should handle pre-request cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await httpClient.get('pre-cancel', { signal: controller.signal });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ERR_CANCELED');
  });

  it('should handle request cancellation', async () => {
    const controller = new AbortController();
    server.use(
      http.get('*/cancel', async () => {
        await new Promise((r) => setTimeout(r, 100));
        return HttpResponse.json({ ok: true });
      })
    );

    const promise = httpClient.get('cancel', { signal: controller.signal });
    controller.abort();

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ERR_CANCELED');
  });

  it('should handle network errors', async () => {
    server.use(
      http.get('*/network-error', () => {
        return HttpResponse.error();
      })
    );

    const result = await httpClient.get('network-error');
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('error');
  });

  it('should identify 500 errors as retryable', async () => {
    let attempts = 0;
    server.use(
      http.get('*/retry-500', () => {
        attempts++;
        if (attempts === 1) return new HttpResponse(null, { status: 500 });
        return HttpResponse.json({ ok: true });
      })
    );
    // @ts-expect-error - spying on private sleep
    vi.spyOn(httpClient, 'sleep').mockResolvedValue(undefined);

    const result = await httpClient.get('retry-500');
    expect(result.success).toBe(true);
    expect(attempts).toBe(2);
  });

  it('should reject lambda response without body as EMPTY_RESPONSE', async () => {
    server.use(
      http.post('*/edges', () => {
        return HttpResponse.json({
          statusCode: 200,
          // missing body
        });
      })
    );

    const result = await httpClient.makeRequest('edges', 'op');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EMPTY_RESPONSE');
  });

  describe('Zod schema validation', () => {
    const testSchema = z.object({
      name: z.string(),
      count: z.number(),
    });

    it('should validate response with Zod schema when provided', async () => {
      server.use(
        http.get('*/schema-test', () => {
          return HttpResponse.json({ name: 'test', count: 42 });
        })
      );

      const result = await httpClient.get('schema-test', { schema: testSchema });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: 'test', count: 42 });
    });

    it('should fail when response does not match Zod schema', async () => {
      server.use(
        http.get('*/schema-fail', () => {
          return HttpResponse.json({ name: 'test', count: 'not-a-number' });
        })
      );

      const result = await httpClient.get('schema-fail', { schema: testSchema });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Response validation failed');
      expect(result.error?.code).toBe('SCHEMA_VALIDATION_ERROR');
    });

    it('should validate lambda-wrapped response with schema', async () => {
      server.use(
        http.post('*/schema-lambda', () => {
          return HttpResponse.json({
            statusCode: 200,
            body: JSON.stringify({ name: 'lambda', count: 7 }),
          });
        })
      );

      const result = await httpClient.makeRequest(
        'schema-lambda',
        'op',
        {},
        { schema: testSchema }
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: 'lambda', count: 7 });
    });

    it('should work without schema (backward compatible)', async () => {
      server.use(
        http.get('*/no-schema', () => {
          return HttpResponse.json({ arbitrary: 'data' });
        })
      );

      const result = await httpClient.get<{ arbitrary: string }>('no-schema');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ arbitrary: 'data' });
    });
  });

  describe('unwrapLambdaResponse null/undefined guard', () => {
    it('should throw EMPTY_RESPONSE for null lambda body', async () => {
      server.use(
        http.post('*/edges', () => {
          return HttpResponse.json({
            statusCode: 200,
            body: 'null',
          });
        })
      );

      const result = await httpClient.makeRequest('edges', 'op');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EMPTY_RESPONSE');
      expect(result.error?.message).toBe('Response body is empty');
    });

    it('should return valid response body without schema', async () => {
      server.use(
        http.post('*/edges', () => {
          return HttpResponse.json({
            statusCode: 200,
            body: JSON.stringify({ key: 'value' }),
          });
        })
      );

      const result = await httpClient.makeRequest<{ key: string }>('edges', 'op');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });
  });
});
