import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { MessageSquare, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/features/auth';
import { useToast } from '@/shared/hooks';
import { isCognitoConfigured } from '@/config/appConfig';
import { useAuthFlow } from '@/features/auth/hooks/useAuthFlow';
import { VerificationForm } from '@/features/auth/components/VerificationForm';
import { AuthForm } from '@/features/auth/components/AuthForm';

const Auth = () => {
  const navigate = useNavigate();
  const { signIn, signUp, confirmSignUp, resendConfirmationCode } = useAuth();
  const { toast } = useToast();

  const flow = useAuthFlow({
    signIn,
    signUp,
    confirmSignUp,
    resendConfirmationCode,
    toast,
    navigate,
  });

  if (flow.showVerification) {
    return (
      <VerificationForm
        verificationEmail={flow.verificationEmail}
        verificationData={flow.verificationData}
        onVerificationDataChange={flow.setVerificationData}
        onSubmit={flow.handleVerification}
        onResend={flow.handleResendCode}
        onBack={() => flow.setShowVerification(false)}
        isLoading={flow.isLoading}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      {/* Navigation */}
      <nav className="bg-white/5 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center space-x-4">
              <Button
                variant="ghost"
                onClick={() => navigate('/')}
                className="text-white hover:bg-white/10"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Home
              </Button>
              <div className="flex items-center space-x-2">
                <MessageSquare className="h-8 w-8 text-blue-400" />
                <span className="text-2xl font-bold text-white">WarmReach</span>
              </div>
            </div>
          </div>
        </div>
      </nav>

      <div className="flex items-center justify-center min-h-[calc(100vh-80px)] px-4 sm:px-6 lg:px-8">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Welcome</h1>
            <p className="text-slate-300">Sign in to your account or create a new one</p>
            {!isCognitoConfigured && (
              <div className="mt-4 p-3 bg-yellow-600/20 border border-yellow-600/30 rounded-lg">
                <p className="text-yellow-200 text-sm">
                  <strong>Demo Mode:</strong> Using mock authentication. Configure AWS Cognito for
                  production.
                </p>
              </div>
            )}
          </div>

          <AuthForm
            signInData={flow.signInData}
            onSignInDataChange={flow.setSignInData}
            onSignIn={flow.handleSignIn}
            signUpData={flow.signUpData}
            onSignUpDataChange={flow.setSignUpData}
            onSignUp={flow.handleSignUp}
            showPassword={flow.showPassword}
            onTogglePassword={() => flow.setShowPassword(!flow.showPassword)}
            isLoading={flow.isLoading}
            isPreloading={flow.isPreloading}
            onPreload={() => flow.setIsPreloading(true)}
          />

          <div className="mt-6 text-center">
            <p className="text-slate-400 text-sm">
              By signing up, you agree to our Terms of Service and Privacy Policy
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Auth;
