// Unified application configuration
// Combines Cognito, API, and UI-related constants in one place
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('AppConfig');

export const cognitoConfig = {
  region: import.meta.env.VITE_AWS_REGION || 'us-east-1',
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
  userPoolWebClientId: import.meta.env.VITE_COGNITO_USER_POOL_WEB_CLIENT_ID || '',
  identityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID || '',
};

const validateCognitoConfig = () => {
  const requiredFields = ['userPoolId', 'userPoolWebClientId'];
  const missing = requiredFields.filter(
    (field) => !cognitoConfig[field as keyof typeof cognitoConfig]
  );
  if (missing.length > 0) {
    logger.warn('Missing Cognito configuration fields', { missing });
    logger.warn('Using mock authentication. Please configure AWS Cognito environment variables');
    return false;
  }
  return true;
};

export const isCognitoConfigured = validateCognitoConfig();

const DEFAULT_API_TIMEOUT_MS = 30000;
const MIN_API_TIMEOUT_MS = 5000;
const MAX_API_TIMEOUT_MS = 120000;

const resolveApiTimeout = (): number => {
  const raw = import.meta.env.VITE_API_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_API_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn('Invalid VITE_API_TIMEOUT_MS value; falling back to default', { raw });
    return DEFAULT_API_TIMEOUT_MS;
  }
  return Math.min(MAX_API_TIMEOUT_MS, Math.max(MIN_API_TIMEOUT_MS, Math.trunc(parsed)));
};

export const API_CONFIG = {
  // Production AWS API Gateway URL (fallback)
  BASE_URL: import.meta.env.VITE_API_GATEWAY_URL || '',
  ENDPOINTS: {
    SEARCH: '/',
    MESSAGE_GENERATION: '/llm',
  },
  TIMEOUT: resolveApiTimeout(),
} as const;

export const STORAGE_KEYS = {
  VISITED_LINKS: 'visitedLinks',
  SEARCH_RESULTS: 'searchResults',
} as const;
