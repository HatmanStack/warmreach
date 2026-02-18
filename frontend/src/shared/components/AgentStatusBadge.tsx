import React from 'react';
import { useWebSocket } from '@/shared/contexts/WebSocketContext';

export const AgentStatusBadge: React.FC = () => {
  const { connectionState, agentConnected } = useWebSocket();

  if (connectionState !== 'connected') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600">
        <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
        Offline
      </span>
    );
  }

  if (agentConnected) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-100 text-green-700">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Agent Connected
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-red-100 text-red-700">
      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      Agent Disconnected
    </span>
  );
};
