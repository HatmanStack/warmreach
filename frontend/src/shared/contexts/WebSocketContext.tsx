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

  // Connect/disconnect based on auth state. Only `user` is in the
  // dep array — getToken is read inside connect() at the time of
  // effect run, but adding it as a dep would tear down + reconnect
  // the socket every time AuthProvider re-renders (the badge flashes
  // "Agent Disconnected" during the reconnect window). user identity
  // is the only thing that should drive a reconnect.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Track connection state. When the socket transitions to connected we
  // ask the backend for the current agent status — backend can't push
  // that during $connect (WS handshake isn't finished there).
  useEffect(() => {
    return websocketService.onStateChange((state) => {
      setConnectionState(state);
      if (state === 'connected') {
        websocketService.send({ action: 'get_agent_status' });
      }
      if (state === 'disconnected') {
        setAgentConnected(false);
      }
    });
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
