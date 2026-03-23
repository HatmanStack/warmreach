import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Key, Eye, EyeOff } from 'lucide-react';
import type { LinkedInCredentialsData } from '../hooks/useLinkedInCredentials';

interface LinkedInCredentialsProps {
  credentials: LinkedInCredentialsData;
  showPassword: boolean;
  hasStoredCredentials: boolean;
  onCredentialsChange: (field: string, value: string) => void;
  onTogglePassword: () => void;
}

export function LinkedInCredentials({
  credentials,
  showPassword,
  hasStoredCredentials,
  onCredentialsChange,
  onTogglePassword,
}: LinkedInCredentialsProps) {
  return (
    <Card className="bg-white/5 backdrop-blur-md border-white/10">
      <CardHeader>
        <CardTitle className="text-white flex items-center">
          <Key className="h-5 w-5 mr-2" />
          LinkedIn Login Credentials
        </CardTitle>
        <CardDescription className="text-slate-300">
          Store your LinkedIn credentials for automated connection imports and post publishing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasStoredCredentials && (
          <div className="bg-emerald-600/20 border border-emerald-600/30 rounded-lg p-3">
            <p className="text-emerald-200 text-sm">
              Credentials are securely stored. Enter new values below to replace them.
            </p>
          </div>
        )}
        <div>
          <Label htmlFor="linkedinEmail" className="text-white">
            LinkedIn Email
          </Label>
          <Input
            id="linkedinEmail"
            type="email"
            value={credentials.email}
            onChange={(e) => onCredentialsChange('email', e.target.value)}
            className="bg-white/5 border-white/20 text-white placeholder-slate-400"
            placeholder="your-email@example.com"
          />
        </div>
        <div>
          <Label htmlFor="linkedinPassword" className="text-white">
            LinkedIn Password
          </Label>
          <div className="relative">
            <Input
              id="linkedinPassword"
              type={showPassword ? 'text' : 'password'}
              value={credentials.password}
              onChange={(e) => onCredentialsChange('password', e.target.value)}
              className="bg-white/5 border-white/20 text-white placeholder-slate-400 pr-10"
              placeholder="••••••••"
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
        <div className="bg-yellow-600/20 border border-yellow-600/30 rounded-lg p-3">
          <p className="text-yellow-200 text-sm">
            <strong>Security Note:</strong> Credentials are transmitted over HTTPS and encrypted at
            rest in DynamoDB (via AWS KMS). Plaintext credentials are never stored.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
