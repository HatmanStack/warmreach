import { render, screen } from '@testing-library/react';
import { AgentStatusBadge } from '../AgentStatusBadge';
import { useWebSocket } from '@/shared/contexts/WebSocketContext';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/contexts/WebSocketContext');

describe('AgentStatusBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show Offline when not connected', () => {
    vi.mocked(useWebSocket).mockReturnValue({
      connectionState: 'disconnected',
      agentConnected: false,
    });

    render(<AgentStatusBadge />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('should show Agent Connected when connected', () => {
    vi.mocked(useWebSocket).mockReturnValue({
      connectionState: 'connected',
      agentConnected: true,
    });

    render(<AgentStatusBadge />);
    expect(screen.getByText('Agent Connected')).toBeInTheDocument();
  });

  it('should show Agent Disconnected when connected but agent is not', () => {
    vi.mocked(useWebSocket).mockReturnValue({
      connectionState: 'connected',
      agentConnected: false,
    });

    render(<AgentStatusBadge />);
    expect(screen.getByText('Agent Disconnected')).toBeInTheDocument();
  });
});
