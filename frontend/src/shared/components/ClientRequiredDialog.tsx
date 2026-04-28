import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useRequireDesktopClient } from '@/shared/contexts/ClientRequiredDialogContext';
import { DesktopClientDownloadPrompt } from '@/features/profile/components/DesktopClientDownloadPrompt';

/**
 * Global modal that opens whenever a client-dependent action is attempted
 * without the desktop agent running. Mounted once at the app root so any
 * dispatch site benefits without per-component wiring.
 */
export const ClientRequiredDialog = () => {
  const { isOpen, closeDialog } = useRequireDesktopClient();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>The desktop client needs to be running</DialogTitle>
          <DialogDescription>
            This action runs in the WarmReach desktop client. Install it (if you haven't yet), then
            launch the tray app — the dialog will close automatically once it's connected.
          </DialogDescription>
        </DialogHeader>
        <DesktopClientDownloadPrompt hideAlreadyInstalled />
      </DialogContent>
    </Dialog>
  );
};
