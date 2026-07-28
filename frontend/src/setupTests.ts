import '@testing-library/jest-dom';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi, beforeAll, afterAll } from 'vitest';
import { server } from './test-utils/msw/server';

// Testing Library's waitFor/findBy* have their own 1000ms budget, separate from
// vitest's testTimeout. Raising testTimeout to 15s in vitest.config.ts does not
// reach them, so under load a waitFor still fails at 1s while the test itself
// has 14s left — observed here as UserProfileContext.test.tsx failing a
// waitFor(() => expect(isLoading).toBe(false)) on a loaded box and passing
// three times out of three in isolation.
//
// 5s, not 15s: it must stay well below testTimeout so a genuinely stuck wait
// still fails as a timed-out wait with the assertion's own error message,
// rather than being swallowed by the test timeout with no useful diagnostic.
configure({ asyncUtilTimeout: 5000 });

// MSW Setup
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

// Cleanup after each test
afterEach(() => {
  server.resetHandlers();
  cleanup();
  vi.clearAllMocks();
});

// Mock local storage
const localStorageMock = (function () {
  let store: Record<string, string> = {};
  return {
    getItem: function (key: string) {
      return store[key] || null;
    },
    setItem: function (key: string, value: string) {
      store[key] = value.toString();
    },
    removeItem: function (key: string) {
      delete store[key];
    },
    clear: function () {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// Mock sessionStorage
const sessionStorageMock = (function () {
  let store: Record<string, string> = {};
  return {
    getItem: function (key: string) {
      return store[key] || null;
    },
    setItem: function (key: string, value: string) {
      store[key] = value.toString();
    },
    removeItem: function (key: string) {
      delete store[key];
    },
    clear: function () {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'sessionStorage', {
  value: sessionStorageMock,
});

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(function () {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(function () {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

// Mock amazon-cognito-identity-js
vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: vi.fn(),
    };
  }),
  CognitoUser: vi.fn(),
  AuthenticationDetails: vi.fn(),
  CognitoUserAttribute: vi.fn(),
  CognitoUserSession: vi.fn(),
}));
