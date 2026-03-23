import { Button } from '@/components/ui/button';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import type { SignInData } from '../hooks/useAuthFlow';

interface SignInFormProps {
  signInData: SignInData;
  onSignInDataChange: (data: SignInData | ((prev: SignInData) => SignInData)) => void;
  onSubmit: (e: React.FormEvent) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
  isLoading: boolean;
  isPreloading: boolean;
  onPreload: () => void;
}

export function SignInForm({
  signInData,
  onSignInDataChange,
  onSubmit,
  showPassword,
  onTogglePassword,
  isLoading,
  isPreloading,
  onPreload,
}: SignInFormProps) {
  return (
    <>
      <CardHeader>
        <CardTitle className="text-white">Sign In</CardTitle>
        <CardDescription className="text-slate-300">
          Enter your credentials to access your account
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label htmlFor="signin-email" className="text-white">
              Email
            </Label>
            <Input
              id="signin-email"
              data-testid="email-input"
              type="email"
              value={signInData.email}
              onChange={(e) => onSignInDataChange((prev) => ({ ...prev, email: e.target.value }))}
              className="bg-white/5 border-white/20 text-white placeholder-slate-400"
              placeholder="your-email@example.com"
              required
              disabled={isLoading}
            />
          </div>
          <div>
            <Label htmlFor="signin-password" className="text-white">
              Password
            </Label>
            <div className="relative">
              <Input
                id="signin-password"
                data-testid="password-input"
                type={showPassword ? 'text' : 'password'}
                value={signInData.password}
                onChange={(e) =>
                  onSignInDataChange((prev) => ({ ...prev, password: e.target.value }))
                }
                className="bg-white/5 border-white/20 text-white placeholder-slate-400 pr-10"
                placeholder="••••••••"
                required
                disabled={isLoading}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                onClick={onTogglePassword}
                disabled={isLoading}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4 text-slate-400" />
                ) : (
                  <Eye className="h-4 w-4 text-slate-400" />
                )}
              </Button>
            </div>
          </div>
          <Button
            type="submit"
            data-testid="sign-in-button"
            className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
            disabled={isLoading}
            aria-busy={isLoading || isPreloading}
            onMouseDown={onPreload}
          >
            {(isPreloading || isLoading) && <Loader2 className="h-4 w-4 animate-spin" />}
            {isPreloading || isLoading ? 'Signing In...' : 'Sign In'}
          </Button>
        </form>
      </CardContent>
    </>
  );
}
