import { httpClient } from '@/shared/utils/httpClient';
import { ApiError } from '@/shared/utils/apiError';
import { logError } from '@/shared/utils/errorHandling';
import { createLogger } from '@/shared/utils/logger';
import {
    validateConnection,
    sanitizeConnectionData,
} from '@/shared/types/validators';
import { isConnection } from '@/shared/types/guards';
import type { Connection, ConnectionStatus } from '@/shared/types';

const logger = createLogger('ConnectionsApiService');

export class ConnectionsApiService {
    async getConnectionsByStatus(status?: ConnectionStatus): Promise<Connection[]> {
        const context = `fetch connections${status ? ` with status ${status}` : ''}`;
        try {
            const response = await httpClient.makeRequest<{
                connections: Connection[];
                count: number;
            }>('edges', 'get_connections_by_status', { updates: status ? { status } : {} });

            const connections = this.formatConnectionsResponse(response.connections || []);
            logger.info(
                `Successfully fetched ${connections.length} connections${status ? ` with status ${status}` : ''}`
            );
            return connections;
        } catch (error) {
            logError(error, context, { status, operation: 'get_connections_by_status' });
            if (error instanceof ApiError) throw error;
            throw new ApiError({
                message: error instanceof Error ? error.message : 'Failed to fetch connections',
                status: 500,
            });
        }
    }

    async updateConnectionStatus(
        connectionId: string,
        newStatus: ConnectionStatus | 'processed',
        options?: { profileId?: string }
    ): Promise<void> {
        const context = `update connection status to ${newStatus}`;
        try {
            if (!connectionId || typeof connectionId !== 'string') {
                throw new ApiError({ message: 'Connection ID is required', status: 400 });
            }
            if (!newStatus || typeof newStatus !== 'string') {
                throw new ApiError({ message: 'New status is required', status: 400 });
            }

            await httpClient.makeRequest<{ success: boolean; updated: Record<string, unknown> }>(
                'edges',
                'update_metadata',
                {
                    profileId: options?.profileId ?? connectionId,
                    updates: { status: newStatus, updatedAt: new Date().toISOString() },
                }
            );
            logger.info(`Successfully updated connection ${connectionId} status to ${newStatus}`);
        } catch (error) {
            logError(error, context, { connectionId, newStatus, operation: 'update_metadata' });
            if (error instanceof ApiError) throw error;
            throw new ApiError({
                message: error instanceof Error ? error.message : 'Failed to update connection status',
                status: 500,
            });
        }
    }

    async computeRelationshipScores(): Promise<{ scoresComputed: number }> {
        return httpClient.makeRequest<{ scoresComputed: number }>('edges', 'compute_relationship_scores');
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
