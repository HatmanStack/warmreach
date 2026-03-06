import axios, { type AxiosInstance, type AxiosResponse, type AxiosError } from 'axios';
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
  public apiClient: AxiosInstance;
  private readonly maxRetries: number = 3;
  private readonly retryDelay: number = 1000;

  constructor(baseURL?: string) {
    const apiBaseUrl = baseURL || import.meta.env.VITE_API_GATEWAY_URL || '';

    if (!apiBaseUrl) {
      logger.warn(
        'No API base URL configured. Set VITE_API_GATEWAY_URL (preferred) or VITE_API_GATEWAY_BASE_URL to avoid defaulting to the current origin (e.g., localhost during dev).'
      );
    }

    const normalizedBaseUrl = apiBaseUrl
      ? apiBaseUrl.endsWith('/')
        ? apiBaseUrl
        : `${apiBaseUrl}/`
      : undefined;

    this.apiClient = axios.create({
      baseURL: normalizedBaseUrl,
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.apiClient.interceptors.request.use(
      async (config) => {
        const token = await this.getAuthToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => {
        return Promise.reject(this.transformError(error));
      }
    );

    this.apiClient.interceptors.response.use(
      (response: AxiosResponse) => {
        return response;
      },
      (error: AxiosError) => {
        return Promise.reject(this.transformError(error));
      }
    );
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

  private transformError(error: AxiosError): ApiError {
    if (error.response) {
      const status = error.response.status;
      const responseData = error.response.data as Record<string, unknown> | null;
      const message =
        (responseData?.message as string) ||
        (responseData?.error as string) ||
        `HTTP ${status} error`;
      const code = (responseData?.code as string) || error.code;

      return new ApiError({ message, status, code });
    } else if (error.request) {
      return new ApiError({
        message: 'Network error - unable to reach server',
        code: error.code,
      });
    } else {
      return new ApiError({
        message: error.message || 'An unexpected error occurred',
        code: error.code,
      });
    }
  }

  private unwrapLambdaResponse<T>(responseData: unknown): T {
    if (responseData && typeof responseData === 'object' && 'statusCode' in responseData) {
      const lambdaResponse = responseData as { statusCode: number; body: unknown };

      if (lambdaResponse.statusCode !== 200) {
        const errorBody =
          typeof lambdaResponse.body === 'string'
            ? JSON.parse(lambdaResponse.body as string)
            : lambdaResponse.body;
        const errorData = errorBody as Record<string, unknown>;
        throw new ApiError({
          message:
            (errorData?.error as string) ||
            (errorData?.message as string) ||
            `Lambda returned status ${lambdaResponse.statusCode}`,
          status: lambdaResponse.statusCode,
          code: errorData?.code as string,
        });
      }

      const parsedBody =
        typeof lambdaResponse.body === 'string'
          ? JSON.parse(lambdaResponse.body as string)
          : lambdaResponse.body;

      return parsedBody as T;
    }
    return responseData as unknown as T;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateBackoffDelay(attempt: number): number {
    return this.retryDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
  }

  private async executeWithRetry<T>(
    requestFn: () => Promise<AxiosResponse<ApiResponse<T>>>,
    logDetails: { endpoint: string; operation?: string; params?: unknown },
    signal?: AbortSignal
  ): Promise<ApiResult<T>> {
    let lastApiError: ApiError | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        return {
          success: false,
          error: { message: 'Request was cancelled', code: 'ABORT_ERR' },
        };
      }

      try {
        const response = await requestFn();
        const data = this.unwrapLambdaResponse<T>(response.data);
        return { success: true, data };
      } catch (error) {
        if (error instanceof Error && error.name === 'CanceledError') {
          return {
            success: false,
            error: { message: 'Request was cancelled', code: 'ABORT_ERR' },
          };
        }

        const apiError =
          error instanceof ApiError ? error : this.transformError(error as AxiosError);
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
    options: { signal?: AbortSignal } = {}
  ): Promise<ApiResult<T>> {
    return this.executeWithRetry<T>(
      () =>
        this.apiClient.post<ApiResponse<T>>(
          endpoint,
          { operation, ...params },
          { signal: options.signal }
        ),
      { endpoint, operation, params: Object.keys(params) },
      options.signal
    );
  }

  public async get<T>(
    endpoint: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<ApiResult<T>> {
    return this.executeWithRetry<T>(
      () => this.apiClient.get<ApiResponse<T>>(endpoint, { signal: options.signal }),
      { endpoint, operation: 'GET' },
      options.signal
    );
  }

  public async post<T>(
    endpoint: string,
    data: unknown,
    options: { signal?: AbortSignal } = {}
  ): Promise<ApiResult<T>> {
    return this.executeWithRetry<T>(
      () => this.apiClient.post<ApiResponse<T>>(endpoint, data, { signal: options.signal }),
      { endpoint, operation: 'POST' },
      options.signal
    );
  }
}

export const httpClient = new HttpClient();
