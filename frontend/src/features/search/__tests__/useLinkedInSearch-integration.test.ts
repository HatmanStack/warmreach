import { renderHook, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server, createAuthenticatedWrapper } from '@/test-utils';
import { useLinkedInSearch } from '../hooks/useLinkedInSearch';
import { describe, it, expect, vi } from 'vitest';

vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: vi.fn().mockReturnValue({
        getSession: vi.fn().mockImplementation((cb) => {
          cb(null, {
            isValid: () => true,
            getIdToken: () => ({
              getJwtToken: () => 'mock-jwt-token',
            }),
          });
        }),
      }),
    };
  }),
  AuthenticationDetails: vi.fn(),
  CognitoUser: vi.fn(),
  CognitoUserAttribute: vi.fn(),
  CognitoUserSession: vi.fn(),
}));

describe('useLinkedInSearch (integration)', () => {
  const mockFetchConnections = vi.fn();

  it('should dispatch search command to API', async () => {
    server.use(
      http.post('*/commands', () => {
        return HttpResponse.json({ commandId: 'cmd-123', status: 'DISPATCHED' });
      })
    );

    const { result } = renderHook(
      () => useLinkedInSearch({ fetchConnections: mockFetchConnections }),
      {
        wrapper: createAuthenticatedWrapper(),
      }
    );

    await act(async () => {
      await result.current.handleLinkedInSearch({
        company: 'Google',
        job: 'Engineer',
        location: 'Mountain View',
        userId: 'user-1',
      });
    });

    await waitFor(() => {
      expect(result.current.isSearchingLinkedIn).toBe(false);
    });

    expect(mockFetchConnections).toHaveBeenCalled();
  });

  it('should handle search errors', async () => {
    server.use(
      http.post('*/commands', () => {
        return new HttpResponse(JSON.stringify({ error: 'Failed to dispatch' }), { status: 500 });
      })
    );

    const { result } = renderHook(
      () => useLinkedInSearch({ fetchConnections: mockFetchConnections }),
      {
        wrapper: createAuthenticatedWrapper(),
      }
    );

    await act(async () => {
      await result.current.handleLinkedInSearch({
        company: 'Fail',
        job: 'Fail',
        location: 'Fail',
        userId: 'user-1',
      });
    });

    await waitFor(() => {
      expect(result.current.isSearchingLinkedIn).toBe(false);
    });

    // Error is handled via toast in handleLinkedInSearch
    expect(mockFetchConnections).not.toHaveBeenCalled();
  });
});
