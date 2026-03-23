// Auth feature barrel export
export { default as ProtectedRoute } from './components/ProtectedRoute';
export { CognitoAuthService } from './services/cognitoService';
export { AuthProvider, useAuth } from './contexts/AuthContext';
export type { User } from './contexts/AuthContext';

// Hooks
export { useAuthFlow } from './hooks/useAuthFlow';

// Components
export { SignInForm } from './components/SignInForm';
export { SignUpForm } from './components/SignUpForm';
export { VerificationForm } from './components/VerificationForm';
export { AuthForm } from './components/AuthForm';
