import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';
import { logError } from '@/shared/utils/errorHandling';
import { createLogger } from '@/shared/utils/logger';
import { validateConnection, sanitizeConnectionData } from '@/shared/types/validators';
import { isConnection } from '@/shared/types/guards';
import type { Connection, ConnectionStatus } from '@/shared/types';

const logger = createLogger('ConnectionsApiService');

class ConnectionsApiService {
  async getConnectionsByStatus(status?: ConnectionStatus): Promise<Connection[]> {
    const context = `fetch connections${status ? ` with status ${status}` : ''}`;
    const result = await httpClient.makeRequest<{
      connections: Connection[];
      count: number;
    }>('edges', 'get_connections_by_status', { updates: status ? { status } : {} });

    if (!result.success) {
      logError(result.error, context, { status, operation: 'get_connections_by_status' });
      throw new ApiError(result.error);
    }

    const connections = this.formatConnectionsResponse(result.data.connections || []);
    logger.info(
      `Successfully fetched ${connections.length} connections${status ? ` with status ${status}` : ''}`
    );
    return connections;
  }

  async updateConnectionStatus(
    connectionId: string,
    newStatus: ConnectionStatus | 'processed',
    options?: { profileId?: string }
  ): Promise<void> {
    const context = `update connection status to ${newStatus}`;
    if (!connectionId || typeof connectionId !== 'string') {
      throw new ApiError({ message: 'Connection ID is required', status: 400 });
    }
    if (!newStatus || typeof newStatus !== 'string') {
      throw new ApiError({ message: 'New status is required', status: 400 });
    }

    const result = await httpClient.makeRequest<{
      success: boolean;
      updated: Record<string, unknown>;
    }>('edges', 'update_metadata', {
      profileId: options?.profileId ?? connectionId,
      updates: { status: newStatus, updatedAt: new Date().toISOString() },
    });

    if (!result.success) {
      logError(result.error, context, { connectionId, newStatus, operation: 'update_metadata' });
      throw new ApiError(result.error);
    }

    logger.info(`Successfully updated connection ${connectionId} status to ${newStatus}`);
  }

  async computeRelationshipScores(): Promise<{ scoresComputed: number }> {
    const result = await httpClient.makeRequest<{ scoresComputed: number }>(
      'analytics',
      'compute_relationship_scores'
    );

    if (!result.success) {
      throw new ApiError(result.error);
    }

    return result.data;
  }

  private formatConnectionsResponse(connections: unknown[]): Connection[] {
    if (!Array.isArray(connections)) {
      logger.warn('Invalid connections data received, expected array', { connections });
      return [];
    }

    return connections
      .map((conn, index) => {
        try {
          const validationResult = validateConnection(conn, { sanitize: false });
          if (validationResult.isValid && isConnection(conn)) {
            return conn as Connection;
          }
        } catch (error) {
          logError(error, 'format connection data validation', { connection: conn, index });
        }

        try {
          const sanitized = sanitizeConnectionData(conn);
          if (sanitized && isConnection(sanitized)) return sanitized;
        } catch {
          // Suppress sanitization errors, fallback to null below
        }

        logger.error(`Unable to sanitize connection data at index ${index}`, { conn });
        return null;
      })
      .filter((conn): conn is Connection => conn !== null);
  }
}

export const connectionsApiService = new ConnectionsApiService();
