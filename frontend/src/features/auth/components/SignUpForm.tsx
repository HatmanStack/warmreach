import { Button } from '@/components/ui/button';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Eye, EyeOff } from 'lucide-react';
import type { SignUpData } from '../hooks/useAuthFlow';

interface SignUpFormProps {
  signUpData: SignUpData;
  onSignUpDataChange: (data: SignUpData | ((prev: SignUpData) => SignUpData)) => void;
  onSubmit: (e: React.FormEvent) => void;
  showPassword: boolean;
  onTogglePassword: () => void;
  isLoading: boolean;
}

export function SignUpForm({
  signUpData,
  onSignUpDataChange,
  onSubmit,
  showPassword,
  onTogglePassword,
  isLoading,
}: SignUpFormProps) {
  return (
    <>
      <CardHeader>
        <CardTitle className="text-white">Create Account</CardTitle>
        <CardDescription className="text-slate-300">
          Create a new account to get started
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="signup-firstname" className="text-white">
                First Name
              </Label>
              <Input
                id="signup-firstname"
                value={signUpData.firstName}
                onChange={(e) =>
                  onSignUpDataChange((prev) => ({ ...prev, firstName: e.target.value }))
                }
                className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                placeholder="John"
              />
            </div>
            <div>
              <Label htmlFor="signup-lastname" className="text-white">
                Last Name
              </Label>
              <Input
                id="signup-lastname"
                value={signUpData.lastName}
                onChange={(e) =>
                  onSignUpDataChange((prev) => ({ ...prev, lastName: e.target.value }))
                }
                className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                placeholder="Doe"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="signup-email" className="text-white">
              Email
            </Label>
            <Input
              id="signup-email"
              type="email"
              value={signUpData.email}
              onChange={(e) => onSignUpDataChange((prev) => ({ ...prev, email: e.target.value }))}
              className="bg-white/5 border-white/20 text-white placeholder-slate-400"
              placeholder="your-email@example.com"
              required
            />
          </div>
          <div>
            <Label htmlFor="signup-password" className="text-white">
              Password
            </Label>
            <div className="relative">
              <Input
                id="signup-password"
                type={showPassword ? 'text' : 'password'}
                value={signUpData.password}
                onChange={(e) =>
                  onSignUpDataChange((prev) => ({ ...prev, password: e.target.value }))
                }
                className="bg-white/5 border-white/20 text-white placeholder-slate-400 pr-10"
                placeholder="••••••••"
                required
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                onClick={onTogglePassword}
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
            className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
            disabled={isLoading}
          >
            {isLoading ? 'Creating Account...' : 'Create Account'}
          </Button>
        </form>
      </CardContent>
    </>
  );
}
