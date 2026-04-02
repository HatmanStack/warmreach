import { render, RenderOptions } from '@testing-library/react';
import { ReactElement } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/features/auth';

/**
 * Create a QueryClient for testing with retry disabled
 */
export const createTestQueryClient = () => {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        cacheTime: 0,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
};

/**
 * Wrapper component that provides common providers for testing
 */
export const AllTheProviders = ({ children }: { children: React.ReactNode }) => {
  const queryClient = createTestQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          {children}
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
};

/**
 * Custom render function that wraps components with common providers
 * Use this instead of @testing-library/react's render for component tests
 */
export const renderWithProviders = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => {
  return render(ui, { wrapper: AllTheProviders, ...options });
};

/**
 * Wait for a condition to be true with a timeout
 */
export const waitForCondition = async (
  condition: () => boolean,
  timeout = 1000,
  interval = 50
): Promise<void> => {
  const startTime = Date.now();

  while (!condition()) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
};

/**
 * Create a mock file for testing file uploads
 */
export const createMockFile = (
  name: string = 'test.txt',
  content: string = 'test content',
  type: string = 'text/plain'
): File => {
  const blob = new Blob([content], { type });
  return new File([blob], name, { type });
};

/**
 * Mock fetch response helper
 */
export const createMockFetchResponse = <T = any>(data: T, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'OK',
  json: () => Promise.resolve(data),
});

/**
 * Mock fetch error response helper
 */
export const createMockFetchError = (message: string, status = 500, data?: any) => ({
  ok: false,
  status,
  statusText: 'Error',
  json: () => Promise.resolve(data || { error: message }),
});

// Re-export everything from @testing-library/react for convenience
export * from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
