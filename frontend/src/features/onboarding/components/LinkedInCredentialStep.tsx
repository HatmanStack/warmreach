import { Button } from '@/components/ui/button';
import { useUserProfile } from '@/features/profile';
import { useOnboarding } from '../hooks/useOnboarding';
import { DesktopClientDownloadPrompt } from '@/features/profile/components/DesktopClientDownloadPrompt';

/**
 * Onboarding step for LinkedIn credentials.
 *
 * Architectural decision: LinkedIn credentials live on-device in the
 * desktop (Electron) client, encrypted with libsodium Sealbox. They are
 * NEVER transmitted to our servers. The web app's job at this step is
 * solely to direct the user to the desktop client.
 *
 * Users who already have the client installed can advance immediately.
 */
export const LinkedInCredentialStep = () => {
  const { completeStep } = useOnboarding();
  const { ciphertext } = useUserProfile();

  const advance = () => completeStep('linkedin_credentials');

  // If a previous session already produced a Sealbox ciphertext (e.g., the
  // user re-entered onboarding), let them skip straight through.
  const alreadyConfigured = !!ciphertext;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold">Connect your LinkedIn account</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          WarmReach uses your LinkedIn credentials locally on your device — they never leave it and
          are never sent to our servers. Install the desktop client to continue.
        </p>
      </div>

      <DesktopClientDownloadPrompt onAlreadyInstalled={advance} />

      {alreadyConfigured && (
        <div className="flex justify-center">
          <Button onClick={advance} data-testid="onboarding-continue" className="min-w-[200px]">
            Continue
          </Button>
        </div>
      )}
    </div>
  );
};
