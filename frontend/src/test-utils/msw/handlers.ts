import { http, HttpResponse } from 'msw';

export const handlers = [
  // GET /dynamodb — user settings
  http.get('*/dynamodb', () => {
    return HttpResponse.json({ settings: { theme: 'light' } });
  }),

  // POST /dynamodb — tier info and other dynamodb operations
  http.post('*/dynamodb', () => {
    return HttpResponse.json({
      tier: 'free',
      features: { deep_research: false },
      quotas: {},
      rateLimits: {},
    });
  }),

  // POST /edges — edge operations (connections, messages, etc.)
  http.post('*/edges', () => {
    return HttpResponse.json({
      statusCode: 200,
      body: JSON.stringify({ results: [] }),
    });
  }),

  // POST /ragstack — search
  http.post('*/ragstack', async ({ request }) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const body = await request.json();
    return HttpResponse.json({
      results: [{ source: 'test-1', score: 0.95, content: 'Test result' }],
      totalResults: 1,
    });
  }),

  // POST /commands — command dispatch
  http.post('*/commands', () => {
    return HttpResponse.json({ commandId: 'cmd-123', status: 'DISPATCHED' });
  }),

  // POST /llm — AI operations
  http.post('*/llm', () => {
    return HttpResponse.json({ result: 'Generated message content' });
  }),

  // GET /profiles — user profile
  http.get('*/profiles', () => {
    return HttpResponse.json({
      success: true,
      data: {
        user_id: 'test-user-id',
        first_name: 'Jane',
        last_name: 'Smith',
        email: 'jane.smith@example.com',
        linkedin_credentials: 'sealbox_x25519:b64:mock-credentials',
      },
    });
  }),

  // POST /profiles — update user settings
  http.post('*/profiles', () => {
    return HttpResponse.json({ success: true });
  }),
];
