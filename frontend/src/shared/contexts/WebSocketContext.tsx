import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from '@/features/auth';
import { websocketService, type ConnectionState } from '@/shared/services/websocketService';

interface WebSocketContextType {
  connectionState: ConnectionState;
  agentConnected: boolean;
}

const WebSocketContext = createContext<WebSocketContextType>({
  connectionState: 'disconnected',
  agentConnected: false,
});

const WS_URL = import.meta.env.VITE_WEBSOCKET_URL || '';

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, getToken } = useAuth();
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [agentConnected, setAgentConnected] = useState(false);

  // Configure URL once
  useEffect(() => {
    if (WS_URL) {
      websocketService.configure(WS_URL);
    }
  }, []);

  // Connect/disconnect based on auth state
  useEffect(() => {
    if (!user || !WS_URL) return;

    let cancelled = false;

    const connect = async () => {
      const token = await getToken();
      if (token && !cancelled) {
        websocketService.connect(token);
      }
    };

    connect();

    return () => {
      cancelled = true;
      websocketService.disconnect();
    };
  }, [user, getToken]);

  // Track connection state
  useEffect(() => {
    return websocketService.onStateChange(setConnectionState);
  }, []);

  // Listen for agent_status messages from backend
  useEffect(() => {
    return websocketService.onMessage((message) => {
      if (message.action === 'agent_status') {
        setAgentConnected(message.connected === true);
      }
    });
  }, []);

  return (
    <WebSocketContext.Provider value={{ connectionState, agentConnected }}>
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocket = () => useContext(WebSocketContext);
