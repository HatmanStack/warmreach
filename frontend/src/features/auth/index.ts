// Auth feature barrel export
export { default as ProtectedRoute } from './components/ProtectedRoute';
export { CognitoAuthService } from './services/cognitoService';
export { AuthProvider, useAuth } from './contexts/AuthContext';
export type { User } from './contexts/AuthContext';

// Hooks
export { useAuthFlow } from './hooks/useAuthFlow';
