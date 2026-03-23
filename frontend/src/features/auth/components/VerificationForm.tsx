import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Mail, MessageSquare } from 'lucide-react';
import type { VerificationData } from '../hooks/useAuthFlow';

interface VerificationFormProps {
  verificationEmail: string;
  verificationData: VerificationData;
  onVerificationDataChange: (
    data: VerificationData | ((prev: VerificationData) => VerificationData)
  ) => void;
  onSubmit: (e: React.FormEvent) => void;
  onResend: () => void;
  onBack: () => void;
  isLoading: boolean;
}

export function VerificationForm({
  verificationEmail,
  verificationData,
  onVerificationDataChange,
  onSubmit,
  onResend,
  onBack,
  isLoading,
}: VerificationFormProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      {/* Navigation */}
      <nav className="bg-white/5 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center space-x-4">
              <Button variant="ghost" onClick={onBack} className="text-white hover:bg-white/10">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
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
            <Mail className="h-16 w-16 text-blue-400 mx-auto mb-4" />
            <h1 className="text-3xl font-bold text-white mb-2">Verify Your Email</h1>
            <p className="text-slate-300">
              We've sent a verification code to <strong>{verificationEmail}</strong>
            </p>
          </div>

          <Card className="bg-white/5 backdrop-blur-md border-white/10">
            <CardHeader>
              <CardTitle className="text-white">Enter Verification Code</CardTitle>
              <CardDescription className="text-slate-300">
                Check your email and enter the 6-digit code below
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="verification-code" className="text-white">
                    Verification Code
                  </Label>
                  <Input
                    id="verification-code"
                    value={verificationData.code}
                    onChange={(e) =>
                      onVerificationDataChange((prev) => ({ ...prev, code: e.target.value }))
                    }
                    className="bg-white/5 border-white/20 text-white placeholder-slate-400 text-center text-lg tracking-widest"
                    placeholder="000000"
                    maxLength={6}
                    required
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
                  disabled={isLoading || verificationData.code.length !== 6}
                >
                  {isLoading ? 'Verifying...' : 'Verify Email'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full border-white/20 text-white hover:bg-white/10"
                  onClick={onResend}
                  disabled={isLoading}
                >
                  Resend Code
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
