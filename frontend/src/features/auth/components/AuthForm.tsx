import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SignInForm } from './SignInForm';
import { SignUpForm } from './SignUpForm';
import type { SignInData, SignUpData } from '../hooks/useAuthFlow';

interface AuthFormProps {
  signInData: SignInData;
  onSignInDataChange: (data: SignInData | ((prev: SignInData) => SignInData)) => void;
  onSignIn: (e: React.FormEvent) => void;
  signUpData: SignUpData;
  onSignUpDataChange: (data: SignUpData | ((prev: SignUpData) => SignUpData)) => void;
  onSignUp: (e: React.FormEvent) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
  isLoading: boolean;
  isPreloading: boolean;
  onPreload: () => void;
}

export function AuthForm({
  signInData,
  onSignInDataChange,
  onSignIn,
  signUpData,
  onSignUpDataChange,
  onSignUp,
  showPassword,
  onTogglePassword,
  isLoading,
  isPreloading,
  onPreload,
}: AuthFormProps) {
  return (
    <Card className="bg-white/5 backdrop-blur-md border-white/10">
      <Tabs defaultValue="signin" className="w-full">
        <TabsList className="grid w-full grid-cols-2 bg-white/5 border-white/10">
          <TabsTrigger
            value="signin"
            className="text-white data-[state=active]:bg-blue-600 data-[state=active]:text-white"
          >
            Sign In
          </TabsTrigger>
          <TabsTrigger
            value="signup"
            className="text-white data-[state=active]:bg-blue-600 data-[state=active]:text-white"
          >
            Sign Up
          </TabsTrigger>
        </TabsList>

        <TabsContent value="signin">
          <SignInForm
            signInData={signInData}
            onSignInDataChange={onSignInDataChange}
            onSubmit={onSignIn}
            showPassword={showPassword}
            onTogglePassword={onTogglePassword}
            isLoading={isLoading}
            isPreloading={isPreloading}
            onPreload={onPreload}
          />
        </TabsContent>

        <TabsContent value="signup">
          <SignUpForm
            signUpData={signUpData}
            onSignUpDataChange={onSignUpDataChange}
            onSubmit={onSignUp}
            showPassword={showPassword}
            onTogglePassword={onTogglePassword}
            isLoading={isLoading}
          />
        </TabsContent>
      </Tabs>
    </Card>
  );
}
