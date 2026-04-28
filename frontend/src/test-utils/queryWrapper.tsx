import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
// Note: we mount a *stub* ClientRequiredDialogContext in tests rather than
// the real Provider. The real Provider reads from WebSocketContext (which
// defaults to agentConnected=false), and that default would cause every
// useCommand.execute() in a test to short-circuit at the gate without
// dispatching — defeating the test. The stub forces agentConnected=true,
// matching the prevailing assumption in pre-gate tests.
import { ClientRequiredDialogContext } from '@/shared/contexts/ClientRequiredDialogContext';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

const TEST_CLIENT_CONTEXT = {
  requireDesktopClient: () => true,
  openDialog: () => {},
  closeDialog: () => {},
  agentConnected: true,
  isOpen: false,
};

export function createWrapper() {
  const testQueryClient = createTestQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={testQueryClient}>
      <ClientRequiredDialogContext.Provider value={TEST_CLIENT_CONTEXT}>
        {children}
      </ClientRequiredDialogContext.Provider>
    </QueryClientProvider>
  );
}
