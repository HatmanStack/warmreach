import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('ErrorBoundary');

/**
 * Catches render-phase errors anywhere below it and shows a recoverable fallback
 * instead of unmounting the tree to a blank screen.
 *
 * Boundary scope (React limitation): error boundaries only catch errors thrown
 * during render, lifecycle methods, and constructors of the components below them.
 * They do NOT catch errors thrown in event handlers or async callbacks outside the
 * render path — those are observed by the global React Query error handler
 * (see `shared/lib/queryClient.ts`) and direct `logger.error` calls at the call site.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackMessage?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Route through the structured logger so caught render errors are observable in
    // production (the logger forwards errors to the telemetry endpoint), not just
    // logged to a console no one is watching.
    logger.error('ErrorBoundary caught an error', {
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          data-testid="error-boundary-fallback"
          className="bg-red-500/10 border border-red-500/20 rounded-lg p-6"
        >
          <div className="flex items-center space-x-3">
            <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0" />
            <div>
              <h3 className="text-red-300 font-medium">Something went wrong</h3>
              <p className="text-red-400 text-sm mt-1">
                {this.props.fallbackMessage || 'An unexpected error occurred. Please try again.'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 border-red-500/30 text-red-300 hover:bg-red-500/10"
                onClick={this.handleRetry}
              >
                Try Again
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
