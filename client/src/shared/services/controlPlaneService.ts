import { logger } from '#utils/logger.js';
import config from '#config';

// Circuit breaker states
const CIRCUIT_CLOSED = 'closed';
const CIRCUIT_OPEN = 'open';
const CIRCUIT_HALF_OPEN = 'half-open';

interface HttpError extends Error {
  response?: { status: number; data: Record<string, unknown> };
  code?: string;
  operation?: string;
  details?: unknown;
}

interface FetchOptions {
  params?: Record<string, string>;
  body?: unknown;
}

interface FetchResult {
  data: Record<string, any>;
}

interface FeatureFlags {
  tier: string;
  features: Record<string, boolean>;
  quotas: Record<string, unknown>;
  rateLimits: Record<string, unknown>;
}

// Class-level static state (survives across instances, not process restarts)
let _circuitState: string = CIRCUIT_CLOSED;
let _consecutiveFailures = 0;
let _circuitOpenedAt: number | null = null;
let _rateLimitCache: Record<string, unknown> | null = null;
let _rateLimitCacheExpiry = 0;
let _featureFlagCache: FeatureFlags | null = null;
let _featureFlagCacheExpiry = 0;

const FAILURE_THRESHOLD = 3;
const RECOVERY_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

class ControlPlaneService {
  private _url: string | undefined;
  private _deploymentId: string | undefined;
  private _apiKey: string | undefined;
  private _baseURL: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;

  constructor() {
    const cp = (config as Record<string, any>).controlPlane || {};
    this._url = cp.url as string | undefined;
    this._deploymentId = cp.deploymentId as string | undefined;
    this._apiKey = cp.apiKey as string | undefined;

    if (this._url) {
      this._baseURL = this._url.endsWith('/') ? this._url : `${this._url}/`;
      this._defaultHeaders = {
        'Content-Type': 'application/json',
        ...(this._apiKey ? { 'x-api-key': this._apiKey } : {}),
      };
    }
  }

  get isConfigured(): boolean {
    return Boolean(this._url);
  }

  async _fetch(
    method: string,
    path: string,
    { params, body }: FetchOptions = {}
  ): Promise<FetchResult> {
    let url = `${this._baseURL}${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += `?${qs}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const init: RequestInit = {
        method,
        headers: this._defaultHeaders,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);

      if (!response.ok) {
        const err: HttpError = new Error(`HTTP ${response.status}`);
        err.response = {
          status: response.status,
          data: (await response.json().catch(() => ({}))) as Record<string, unknown>,
        };
        throw err;
      }

      return { data: (await response.json()) as Record<string, any> };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async _get(path: string, options?: FetchOptions): Promise<FetchResult> {
    return this._fetch('GET', path, options);
  }

  async _post(path: string, body?: unknown): Promise<FetchResult> {
    return this._fetch('POST', path, { body });
  }

  _isCircuitOpen(): boolean {
    if (_circuitState === CIRCUIT_OPEN) {
      const elapsed = Date.now() - (_circuitOpenedAt ?? 0);
      if (elapsed >= RECOVERY_TIMEOUT_MS) {
        _circuitState = CIRCUIT_HALF_OPEN;
        logger.debug('Control plane circuit breaker: half-open (testing)');
        return false;
      }
      return true;
    }
    return false;
  }

  _recordSuccess(): void {
    _consecutiveFailures = 0;
    if (_circuitState === CIRCUIT_HALF_OPEN) {
      _circuitState = CIRCUIT_CLOSED;
      logger.debug('Control plane circuit breaker: closed (recovered)');
    }
  }

  _recordFailure(error: HttpError | null): void {
    _consecutiveFailures += 1;
    if (_consecutiveFailures >= FAILURE_THRESHOLD && _circuitState !== CIRCUIT_OPEN) {
      _circuitState = CIRCUIT_OPEN;
      _circuitOpenedAt = Date.now();
      logger.warn('Control plane circuit breaker: open', {
        failures: _consecutiveFailures,
        error: error?.message,
      });
    }
  }

  async syncRateLimits(): Promise<Record<string, unknown> | null> {
    if (!this.isConfigured) return null;
    if (this._isCircuitOpen()) return _rateLimitCache;

    if (_rateLimitCache && Date.now() < _rateLimitCacheExpiry) {
      return _rateLimitCache;
    }

    try {
      const params: Record<string, string> = {};
      if (this._deploymentId) params.deploymentId = this._deploymentId;
      const response = await this._get('rate-limits', { params });
      this._recordSuccess();

      _rateLimitCache = response.data;
      _rateLimitCacheExpiry = Date.now() + CACHE_TTL_MS;
      return _rateLimitCache;
    } catch (err: unknown) {
      const error = err as HttpError;
      this._recordFailure(error);
      logger.debug('Control plane syncRateLimits failed', { error: error.message });
      return _rateLimitCache;
    }
  }

  reportInteraction(operation: string, metadata: Record<string, unknown> = {}): void {
    if (!this.isConfigured) return;
    if (this._isCircuitOpen()) return;

    const payload = {
      deploymentId: this._deploymentId,
      operation,
      metadata,
      timestamp: new Date().toISOString(),
    };

    this._post('report-interaction', payload).then(
      () => this._recordSuccess(),
      (error: HttpError) => {
        this._recordFailure(error);
        logger.debug('Control plane reportInteraction failed', { error: error.message });
      }
    );
  }

  async register(stackInfo: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!this.isConfigured) return null;

    try {
      const response = await this._post('register', stackInfo);
      this._recordSuccess();
      return response.data;
    } catch (err: unknown) {
      const error = err as HttpError;
      this._recordFailure(error);
      logger.warn('Control plane registration failed', { error: error.message });
      return null;
    }
  }

  async reportUsage(
    operation: string,
    count = 1,
    metadata: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    if (!this.isConfigured) return { allowed: true };
    if (this._isCircuitOpen()) return { allowed: true };

    try {
      const response = await this._post('report-usage', {
        deploymentId: this._deploymentId,
        operation,
        count,
        metadata,
      });
      this._recordSuccess();
      return response.data;
    } catch (err: unknown) {
      const error = err as HttpError;
      if (error.response?.status === 429) {
        this._recordSuccess();
        const body = error.response.data || {};
        const quotaErr: HttpError = new Error((body.message as string) || 'Quota exceeded');
        quotaErr.code = 'QUOTA_EXCEEDED';
        quotaErr.operation = operation;
        quotaErr.details = body;
        throw quotaErr;
      }
      this._recordFailure(error);
      logger.debug('Control plane reportUsage failed', { error: error.message });
      return { allowed: true };
    }
  }

  async getQuotaStatus(operation: string): Promise<Record<string, unknown>> {
    if (!this.isConfigured) return { allowed: true, remaining: -1 };
    if (this._isCircuitOpen()) return { allowed: true, remaining: -1 };

    try {
      const response = await this._post('quota-status', {
        deploymentId: this._deploymentId,
        operation,
      });
      this._recordSuccess();
      return response.data;
    } catch (err: unknown) {
      const error = err as HttpError;
      this._recordFailure(error);
      logger.debug('Control plane getQuotaStatus failed', { error: error.message });
      return { allowed: true, remaining: -1 };
    }
  }

  async getFeatureFlags(forceRefresh = false): Promise<FeatureFlags> {
    if (!this.isConfigured) return this._defaultFeatureFlags();
    if (this._isCircuitOpen()) return _featureFlagCache || this._defaultFeatureFlags();

    if (!forceRefresh && _featureFlagCache && Date.now() < _featureFlagCacheExpiry) {
      return _featureFlagCache;
    }

    try {
      const params: Record<string, string> = {};
      if (this._deploymentId) params.deploymentId = this._deploymentId;
      const response = await this._get('feature-flags', { params });
      this._recordSuccess();

      _featureFlagCache = response.data as unknown as FeatureFlags;
      _featureFlagCacheExpiry = Date.now() + CACHE_TTL_MS;
      return _featureFlagCache;
    } catch (err: unknown) {
      const error = err as HttpError;
      this._recordFailure(error);
      logger.debug('Control plane getFeatureFlags failed', { error: error.message });
      return _featureFlagCache || this._defaultFeatureFlags();
    }
  }

  isFeatureEnabled(featureName: string): boolean {
    const flags = _featureFlagCache || this._defaultFeatureFlags();
    return flags.features?.[featureName] ?? false;
  }

  _defaultFeatureFlags(): FeatureFlags {
    return {
      tier: 'free',
      features: { deep_research: false },
      quotas: {},
      rateLimits: {},
    };
  }

  static _resetState(): void {
    _circuitState = CIRCUIT_CLOSED;
    _consecutiveFailures = 0;
    _circuitOpenedAt = null;
    _rateLimitCache = null;
    _rateLimitCacheExpiry = 0;
    _featureFlagCache = null;
    _featureFlagCacheExpiry = 0;
  }

  static _getState(): Record<string, unknown> {
    return {
      circuitState: _circuitState,
      consecutiveFailures: _consecutiveFailures,
      circuitOpenedAt: _circuitOpenedAt,
      rateLimitCache: _rateLimitCache,
      rateLimitCacheExpiry: _rateLimitCacheExpiry,
      featureFlagCache: _featureFlagCache,
      featureFlagCacheExpiry: _featureFlagCacheExpiry,
    };
  }
}

export default ControlPlaneService;
