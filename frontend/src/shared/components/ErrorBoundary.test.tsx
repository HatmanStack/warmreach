import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  }),
}));

// Suppress console.error from React's error boundary logging during tests
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mockLoggerError.mockClear();
});

let shouldThrow = true;
const ThrowingComponent = () => {
  if (shouldThrow) {
    throw new Error('Test error');
  }
  return <div>Child content</div>;
};

describe('ErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true;
  });

  it('should render children when no error occurs', () => {
    shouldThrow = false;
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('should render error UI when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('An unexpected error occurred. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('should display custom fallback message', () => {
    render(
      <ErrorBoundary fallbackMessage="Custom error message">
        <ThrowingComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText('Custom error message')).toBeInTheDocument();
  });

  it('should report the caught error and errorInfo through the logger seam', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [message, context] = mockLoggerError.mock.calls[0];
    expect(message).toMatch(/caught/i);
    expect(context).toMatchObject({
      error: expect.any(Error),
      componentStack: expect.any(String),
    });
    expect((context.error as Error).message).toBe('Test error');
  });

  it('should recover when Try Again is clicked and child stops throwing', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Stop the child from throwing before clicking retry
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('Child content')).toBeInTheDocument();
  });
});
