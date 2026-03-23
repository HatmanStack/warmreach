import { useState } from 'react';
import { isCognitoConfigured } from '@/config/appConfig';

export interface SignInData {
  email: string;
  password: string;
}

export interface SignUpData {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export interface VerificationData {
  code: string;
}

interface AuthFlowDeps {
  signIn: (email: string, password: string) => Promise<{ error: { message: string } | null }>;
  signUp: (
    email: string,
    password: string,
    firstName?: string,
    lastName?: string
  ) => Promise<{ error: { message: string } | null; needsVerification?: boolean }>;
  confirmSignUp?: (email: string, code: string) => Promise<{ error: { message: string } | null }>;
  resendConfirmationCode?: (email: string) => Promise<{ error: { message: string } | null }>;
  toast: (opts: {
    title: string;
    description: string;
    variant?: 'destructive' | 'default';
  }) => void;
  navigate: (path: string) => void;
}

export function useAuthFlow({
  signIn,
  signUp,
  confirmSignUp,
  resendConfirmationCode,
  toast,
  navigate,
}: AuthFlowDeps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isPreloading, setIsPreloading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showVerification, setShowVerification] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState('');

  const [signInData, setSignInData] = useState<SignInData>({
    email: '',
    password: '',
  });

  const [signUpData, setSignUpData] = useState<SignUpData>({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
  });

  const [verificationData, setVerificationData] = useState<VerificationData>({
    code: '',
  });

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPreloading) setIsPreloading(false);
    setIsLoading(true);

    try {
      const { error } = await signIn(signInData.email, signInData.password);

      if (error) {
        toast({
          title: 'Sign In Failed',
          description: error.message || 'Invalid credentials',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Welcome back!',
          description: 'You have been signed in successfully.',
        });
        navigate('/dashboard');
      }
    } catch {
      toast({
        title: 'Sign In Failed',
        description: 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const result = await signUp(
        signUpData.email,
        signUpData.password,
        signUpData.firstName,
        signUpData.lastName
      );

      if (result.error) {
        toast({
          title: 'Sign Up Failed',
          description: result.error.message || 'Registration failed',
          variant: 'destructive',
        });
      } else {
        if (isCognitoConfigured && result.needsVerification) {
          setVerificationEmail(signUpData.email);
          setShowVerification(true);
          toast({
            title: 'Check Your Email',
            description:
              "We've sent you a verification code. Please check your email and enter the code below.",
          });
        } else {
          toast({
            title: 'Welcome!',
            description: 'Your account has been created successfully.',
          });
          navigate('/dashboard');
        }
      }
    } catch {
      toast({
        title: 'Sign Up Failed',
        description: 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmSignUp) return;

    setIsLoading(true);

    try {
      const { error } = await confirmSignUp(verificationEmail, verificationData.code);

      if (error) {
        toast({
          title: 'Verification Failed',
          description: error.message || 'Invalid verification code',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Email Verified!',
          description: 'Your account has been verified. You can now sign in.',
        });
        setShowVerification(false);
        setVerificationData({ code: '' });
      }
    } catch {
      toast({
        title: 'Verification Failed',
        description: 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!resendConfirmationCode) return;

    setIsLoading(true);

    try {
      const { error } = await resendConfirmationCode(verificationEmail);

      if (error) {
        toast({
          title: 'Resend Failed',
          description: error.message || 'Failed to resend verification code',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Code Sent',
          description: 'A new verification code has been sent to your email.',
        });
      }
    } catch {
      toast({
        title: 'Resend Failed',
        description: 'An unexpected error occurred',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    isPreloading,
    setIsPreloading,
    showPassword,
    setShowPassword,
    showVerification,
    setShowVerification,
    verificationEmail,
    signInData,
    setSignInData,
    signUpData,
    setSignUpData,
    verificationData,
    setVerificationData,
    handleSignIn,
    handleSignUp,
    handleVerification,
    handleResendCode,
  };
}
