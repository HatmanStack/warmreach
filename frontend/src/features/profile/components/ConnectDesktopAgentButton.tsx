import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { CognitoAuthService } from '@/features/auth/services/cognitoService';
import { Link2 } from 'lucide-react';

const AGENT_URL = 'http://localhost:3001/auth/token';

/**
 * One-click button that pushes Cognito tokens to the locally-running
 * desktop agent so it can subscribe to the cloud WebSocket as
 * clientType=agent. The agent uses the refresh token to mint new id
 * tokens automatically — no repaste required.
 */
export const ConnectDesktopAgentButton = () => {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    setBusy(true);
    try {
      const payload = await CognitoAuthService.getDesktopAgentTokens();
      if (!payload) {
        toast({
          title: 'Not signed in',
          description: 'Sign in again, then retry.',
          variant: 'destructive',
        });
        return;
      }
      const resp = await fetch(AGENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`Agent rejected (HTTP ${resp.status}): ${detail || 'unknown'}`);
      }
      toast({
        title: 'Connecting…',
        description: 'Tokens sent. The status pill should flip to Connected shortly.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast({
        title: 'Could not reach the desktop agent',
        description: `${msg}. Make sure the WarmReach Agent app is running on this machine.`,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button onClick={handleClick} disabled={busy} className="gap-2">
      <Link2 className="h-4 w-4" />
      {busy ? 'Connecting…' : 'Connect Desktop Agent'}
    </Button>
  );
};
