import { type ZodType } from 'zod';
import { CognitoAuthService } from '@/features/auth';
import { createLogger } from '@/shared/utils/logger';
import { ApiError } from '@/shared/utils/apiError';
import type { ApiResult, ApiResponse } from '@/shared/types';

const logger = createLogger('HttpClient');

/**
 * Base HTTP Client with built-in retry logic, exponential backoff, and auth token injection.
 * Returns ApiResult<T> for consistent and safe error handling.
 */
class HttpClient {
  private readonly baseURL: string;
  private readonly timeout: number = 60000;
  private readonly maxRetries: number = 3;
  private readonly retryDelay: number = 1000;

  constructor(baseURL?: string) {
    const apiBaseUrl = baseURL || import.meta.env.VITE_API_GATEWAY_URL || '';

    if (!apiBaseUrl) {
      logger.warn(
        'No API base URL configured. Set VITE_API_GATEWAY_URL (preferred) or VITE_API_GATEWAY_BASE_URL to avoid defaulting to the current origin (e.g., localhost during dev).'
      );
    }

    this.baseURL = apiBaseUrl ? (apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`) : '';
  }

  private async getAuthToken(): Promise<string | null> {
    try {
      const token = await CognitoAuthService.getCurrentUserToken();
      return token || null;
    } catch (error) {
      logger.error('Error getting auth token', { error });
      return null;
    }
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = await this.getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private transformError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;

    if (error instanceof TypeError) {
      return new ApiError({
        message: 'Network error - unable to reach server',
        code: 'ERR_NETWORK',
      });
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      return new ApiError({
        message: 'Request was cancelled',
        code: 'ERR_CANCELED',
      });
    }

    const message = error instanceof Error ? error.message : 'An unexpected error occurred';
    return new ApiError({ message });
  }

  private async parseResponseError(response: Response): Promise<ApiError> {
    const status = response.status;
    let message = `HTTP ${status} error`;
    let code: string | undefined;

    try {
      const body = await response.json();
      message = body?.message || body?.error || message;
      code = body?.code;
    } catch {
      // Response body not JSON, use status text
    }

    return new ApiError({ message, status, code });
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const existingSignal = init.signal;

    // Combine user-provided signal with timeout signal
    if (existingSignal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const onExternalAbort = () => controller.abort();
    existingSignal?.addEventListener('abort', onExternalAbort);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
      existingSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async fetchJSON<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    options?: { body?: unknown; signal?: AbortSignal }
  ): Promise<{ data: T }> {
    const headers = await this.buildHeaders();
    const url = `${this.baseURL}${endpoint}`;

    const init: RequestInit = {
      method,
      headers,
      signal: options?.signal,
    };

    if (options?.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetchWithTimeout(url, init);

    if (!response.ok) {
      throw await this.parseResponseError(response);
    }

    const data = await response.json();
    return { data };
  }

  private unwrapLambdaResponse<T>(responseData: unknown, schema?: ZodType<T>): T {
    let result: unknown;

    if (responseData && typeof responseData === 'object' && 'statusCode' in responseData) {
      const lambdaResponse = responseData as { statusCode: number; body: unknown };

      if (lambdaResponse.statusCode !== 200) {
        const errorBody =
          typeof lambdaResponse.body === 'string'
            ? JSON.parse(lambdaResponse.body as string)
            : lambdaResponse.body;
        const errorData = errorBody as Record<string, unknown>;
        // Accept both shapes during rollout:
        //   legacy:   { error: 'message', code?, message? }
        //   canonical:{ error: { code, message, details? } }
        const structured =
          errorData?.error && typeof errorData.error === 'object'
            ? (errorData.error as Record<string, unknown>)
            : null;
        const message =
          (structured?.message as string) ||
          (typeof errorData?.error === 'string' ? (errorData.error as string) : '') ||
          (errorData?.message as string) ||
          `Lambda returned status ${lambdaResponse.statusCode}`;
        const code =
          (structured?.code as string | undefined) ?? (errorData?.code as string | undefined);
        throw new ApiError({
          message,
          status: lambdaResponse.statusCode,
          code,
        });
      }

      result =
        typeof lambdaResponse.body === 'string'
          ? JSON.parse(lambdaResponse.body as string)
          : lambdaResponse.body;
    } else {
      result = responseData;
    }

    if (schema) {
      try {
        return schema.parse(result);
      } catch (e) {
        throw new ApiError({
          message: `Response validation failed: ${e instanceof Error ? e.message : 'Unknown validation error'}`,
          status: 502,
          code: 'SCHEMA_VALIDATION_ERROR',
        });
      }
    }
    if (result === null || result === undefined) {
      throw new ApiError({
        message: 'Response body is empty',
        status: 502,
        code: 'EMPTY_RESPONSE',
      });
    }
    return result as T;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateBackoffDelay(attempt: number): number {
    return this.retryDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
  }

  private async executeWithRetry<T>(
    requestFn: () => Promise<{ data: ApiResponse<T> }>,
    logDetails: { endpoint: string; operation?: string; params?: unknown },
    signal?: AbortSignal,
    schema?: ZodType<T>
  ): Promise<ApiResult<T>> {
    let lastApiError: ApiError | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        return {
          success: false,
          error: { message: 'Request was cancelled', code: 'ERR_CANCELED' },
        };
      }

      try {
        const response = await requestFn();
        const data = this.unwrapLambdaResponse<T>(response.data, schema);
        return { success: true, data };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return {
            success: false,
            error: { message: 'Request was cancelled', code: 'ERR_CANCELED' },
          };
        }

        const apiError = this.transformError(error);
        lastApiError = apiError;

        if (!apiError.retryable || attempt === this.maxRetries) {
          logger.error(`API request failed after ${attempt} attempts`, {
            ...logDetails,
            error: apiError.toJSON(),
          });
          return {
            success: false,
            error: {
              message: apiError.message,
              status: apiError.status,
              code: apiError.code,
            },
          };
        }

        const delay = this.calculateBackoffDelay(attempt);
        logger.warn(
          `API request failed (attempt ${attempt}/${this.maxRetries}), retrying in ${delay}ms`,
          {
            ...logDetails,
            error: apiError.message,
            nextRetryIn: delay,
          }
        );

        await this.sleep(delay);
      }
    }

    return {
      success: false,
      error: {
        message: lastApiError?.message || 'Max retries exceeded',
        status: lastApiError?.status,
        code: lastApiError?.code || 'MAX_RETRIES_ERR',
      },
    };
  }

  public async makeRequest<T>(
    endpoint: string,
    operation: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; schema?: ZodType<T> } = {}
  ): Promise<ApiResult<T>> {
    return this.executeWithRetry<T>(
      () =>
        this.fetchJSON<ApiResponse<T>>('POST', endpoint, {
          body: { operation, ...params },
          signal: options.signal,
        }),
      { endpoint, operation, params: Object.keys(params) },
      options.signal,
      options.schema
    );
  }

  public async get<T>(
    endpoint: string,
    options: { signal?: AbortSignal; schema?: ZodType<T> } = {}
  ): Promise<ApiResult<T>> {
    return this.executeWithRetry<T>(
      () => this.fetchJSON<ApiResponse<T>>('GET', endpoint, { signal: options.signal }),
      { endpoint, operation: 'GET' },
      options.signal,
      options.schema
    );
  }

  public async post<T>(
    endpoint: string,
    data: unknown,
    options: { signal?: AbortSignal; schema?: ZodType<T> } = {}
  ): Promise<ApiResult<T>> {
    return this.executeWithRetry<T>(
      () =>
        this.fetchJSON<ApiResponse<T>>('POST', endpoint, {
          body: data,
          signal: options.signal,
        }),
      { endpoint, operation: 'POST' },
      options.signal,
      options.schema
    );
  }

  /**
   * Raw fetch client for callers that need direct { data } responses
   * without the ApiResult wrapper or retry logic.
   */
  public apiClient = {
    post: <T>(endpoint: string, data?: unknown, options?: { signal?: AbortSignal }) =>
      this.rawFetch<T>('POST', endpoint, { body: data, signal: options?.signal }),
    get: <T>(endpoint: string, options?: { signal?: AbortSignal }) =>
      this.rawFetch<T>('GET', endpoint, { signal: options?.signal }),
  };

  private async rawFetch<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    options?: { body?: unknown; signal?: AbortSignal }
  ): Promise<{ data: T }> {
    return this.fetchJSON<T>(method, endpoint, options);
  }
}

export const httpClient = new HttpClient();
