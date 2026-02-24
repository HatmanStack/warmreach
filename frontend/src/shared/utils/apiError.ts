import type { ApiErrorInfo } from '@/shared/types';

export class ApiError extends Error {
    status?: number;
    code?: string;
    retryable?: boolean;
    timestamp: string;

    constructor({ message, status, code }: ApiErrorInfo) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.timestamp = new Date().toISOString();

        // Determine if error is retryable based on status code
        this.retryable = this.isRetryableError(status, code);
    }

    private isRetryableError(status?: number, code?: string): boolean {
        // Network errors are retryable
        if (
            !status &&
            (code === 'NETWORK_ERROR' || code === 'ERR_NETWORK' || code === 'ECONNABORTED')
        ) {
            return true;
        }

        // Server errors (5xx) are retryable
        if (status && status >= 500) {
            return true;
        }

        // Rate limiting is retryable, unless it's a hard quota limit
        if (status === 429 && code !== 'QUOTA_EXCEEDED') {
            return true;
        }

        // Timeout errors are retryable
        if (code === 'TIMEOUT') {
            return true;
        }

        return false;
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            status: this.status,
            code: this.code,
            retryable: this.retryable,
            timestamp: this.timestamp,
            stack: this.stack,
        };
    }
}
