import { connectionsApiService } from './connectionsApiService';
import { messagesApiService } from './messagesApiService';
import { profileApiService } from './profileApiService';
import { analyticsApiService } from './analyticsApiService';
import { httpClient } from '@/shared/utils/httpClient';
import type { Connection, Message, ConnectionStatus, UserProfile, ApiResult } from '@/shared/types';
import type { AxiosInstance } from 'axios';

// Export needed interfaces from the old file
class LambdaApiServiceFacade {
  // Expose apiClient for hooks that use it directly
  public get apiClient(): AxiosInstance {
    return httpClient.apiClient;
  }

  // --- Connections API ---
  async getConnectionsByStatus(status?: ConnectionStatus): Promise<Connection[]> {
    return connectionsApiService.getConnectionsByStatus(status);
  }

  async updateConnectionStatus(
    connectionId: string,
    newStatus: ConnectionStatus | 'processed',
    options?: { profileId?: string }
  ): Promise<void> {
    return connectionsApiService.updateConnectionStatus(connectionId, newStatus, options);
  }

  async computeRelationshipScores(): Promise<{ scoresComputed: number }> {
    return connectionsApiService.computeRelationshipScores();
  }

  // --- Messages API ---
  async getMessageHistory(connectionId: string): Promise<Message[]> {
    return messagesApiService.getMessageHistory(connectionId);
  }

  // --- Analytics & LLM API ---
  async getMessagingInsights(
    forceRecompute = false
  ): ReturnType<typeof analyticsApiService.getMessagingInsights> {
    return analyticsApiService.getMessagingInsights(forceRecompute);
  }

  async analyzeMessagePatterns(
    stats: Record<string, unknown>,
    sampleMessages: Record<string, unknown>[]
  ): ReturnType<typeof analyticsApiService.analyzeMessagePatterns> {
    return analyticsApiService.analyzeMessagePatterns(stats, sampleMessages);
  }

  async getAnalyticsDashboard(
    days = 30
  ): ReturnType<typeof analyticsApiService.getAnalyticsDashboard> {
    return analyticsApiService.getAnalyticsDashboard(days);
  }

  async storeMessageInsights(
    insights: string[]
  ): ReturnType<typeof analyticsApiService.storeMessageInsights> {
    return analyticsApiService.storeMessageInsights(insights);
  }

  async sendLLMRequest(
    operation: string,
    params: Record<string, unknown> = {}
  ): ReturnType<typeof analyticsApiService.sendLLMRequest> {
    return analyticsApiService.sendLLMRequest(operation, params);
  }

  // --- Profile API ---
  async getUserProfile(): ReturnType<typeof profileApiService.getUserProfile> {
    return profileApiService.getUserProfile();
  }

  async updateUserProfile(
    profile: Partial<UserProfile>
  ): ReturnType<typeof profileApiService.updateUserProfile> {
    return profileApiService.updateUserProfile(profile);
  }

  async createUserProfile(
    profile: Omit<UserProfile, 'user_id' | 'created_at' | 'updated_at'>
  ): ReturnType<typeof profileApiService.createUserProfile> {
    return profileApiService.createUserProfile(profile);
  }

  // Backwards compatibility for arbitrary operations
  async makeRequest<T>(
    endpoint: string,
    operation: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {}
  ): Promise<ApiResult<T>> {
    return httpClient.makeRequest<T>(endpoint, operation, params, options);
  }
}

export const lambdaApiService = new LambdaApiServiceFacade();
