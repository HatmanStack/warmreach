import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Eye, EyeOff, Shield } from 'lucide-react';
import { useUserProfile } from '@/features/profile';
import { useOnboarding } from '../hooks/useOnboarding';
import { encryptWithSealboxB64 } from '@/shared/utils/crypto';

export const LinkedInCredentialStep = () => {
  const { completeStep } = useOnboarding();
  const { ciphertext, setCiphertext, updateUserProfile } = useUserProfile();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const hasCredentials = !!ciphertext;
  const canContinue = hasCredentials || (email.trim() !== '' && password.trim() !== '');

  const handleSaveAndContinue = async () => {
    setIsSaving(true);
    try {
      // If user entered new credentials, save them
      if (email && password) {
        const sealboxPubB64 = import.meta.env.VITE_CRED_SEALBOX_PUBLIC_KEY_B64 as
          | string
          | undefined;

        if (!sealboxPubB64 || typeof sealboxPubB64 !== 'string') {
          throw new Error(
            'VITE_CRED_SEALBOX_PUBLIC_KEY_B64 is not configured. Cannot store credentials without encryption.'
          );
        }

        const json = JSON.stringify({ email, password });
        const ciphertextB64 = await encryptWithSealboxB64(json, sealboxPubB64);
        const credentialValue = `sealbox_x25519:b64:${ciphertextB64}`;
        setCiphertext(credentialValue);

        await updateUserProfile({ linkedin_credentials: credentialValue });
        setPassword('');
      }

      await completeStep('linkedin_credentials');
    } catch {
      // Error handled by profile context
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="mx-auto w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
          <Shield className="h-6 w-6 text-blue-600 dark:text-blue-400" />
        </div>
        <h2 className="text-2xl font-bold">Connect Your LinkedIn Account</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          WarmReach needs your LinkedIn credentials to import connections and send messages.
          Credentials are encrypted with Sealbox (X25519) and never stored in plaintext.
        </p>
      </div>

      {hasCredentials ? (
        <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20 p-4 text-center">
          <p className="text-green-800 dark:text-green-200 font-medium">
            LinkedIn credentials are securely stored.
          </p>
          <p className="text-sm text-green-600 dark:text-green-300 mt-1">
            You can update them anytime from your Profile page.
          </p>
        </div>
      ) : (
        <div className="space-y-4 max-w-sm mx-auto">
          <div>
            <Label htmlFor="onboarding-email">LinkedIn Email</Label>
            <Input
              id="onboarding-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your-email@example.com"
            />
          </div>
          <div>
            <Label htmlFor="onboarding-password">LinkedIn Password</Label>
            <div className="relative">
              <Input
                id="onboarding-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Transmitted over HTTPS and encrypted at rest. Never stored in plaintext.
          </p>
        </div>
      )}

      <div className="flex justify-center">
        <Button
          onClick={handleSaveAndContinue}
          disabled={!canContinue || isSaving}
          className="min-w-[200px]"
          data-testid="onboarding-continue"
        >
          {isSaving ? 'Saving...' : 'Continue'}
        </Button>
      </div>
    </div>
  );
};
