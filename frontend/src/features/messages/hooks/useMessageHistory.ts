import { useState, useCallback } from 'react';
import type { Message } from '@/types';
import { messagesApiService } from '@/shared/services/messagesApiService';

export function useMessageHistory() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async (connectionId: string | null) => {
    if (!connectionId) {
      setMessages([]);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const fetched = await messagesApiService.getMessageHistory(connectionId);
      if (Array.isArray(fetched)) {
        setMessages(fetched);
      } else {
        setMessages([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
      setMessages([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  return {
    messages,
    isLoading,
    error,
    fetchHistory,
    addMessage,
    clearHistory,
  };
}
