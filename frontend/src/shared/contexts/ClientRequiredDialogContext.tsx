import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useWebSocket } from './WebSocketContext';

/**
 * Centralized "you need the desktop client to do this" gate.
 *
 * Architectural decision: every command dispatched through commandService
 * runs in the Electron desktop client (Puppeteer is the substrate for all
 * automation). If the agent isn't connected when the user tries to act,
 * we open a modal with the download prompt instead of letting the dispatch
 * silently time out.
 *
 * Usage:
 *   const { requireDesktopClient, agentConnected } = useRequireDesktopClient();
 *   if (!requireDesktopClient()) return; // dialog opened, abort
 *   await doTheThing();
 *
 * The dialog auto-closes when agentConnected flips true.
 */

interface ClientRequiredDialogContextType {
  /** Returns true if the client is connected and the action can proceed.
   *  Returns false (and opens the dialog) otherwise. */
  requireDesktopClient: () => boolean;
  /** Imperatively open the dialog (e.g. from a button labelled "Get the client"). */
  openDialog: () => void;
  /** Imperatively close the dialog. */
  closeDialog: () => void;
  /** Mirrors useWebSocket().agentConnected for convenience. */
  agentConnected: boolean;
  /** Current dialog open state — used by ClientRequiredDialog itself. */
  isOpen: boolean;
}

// A permissive default so consumers used outside the provider (notably
// component tests that render hooks/children directly via renderHook
// without a wrapper) don't get gated and don't blow up. Production
// behavior is unaffected because App.tsx always mounts the real Provider
// at the root, which overrides this default. requireDesktopClient
// returns true in this default so tests that don't explicitly test the
// gate UX can dispatch commands as if the agent were connected.
const noopContext: ClientRequiredDialogContextType = {
  requireDesktopClient: () => true,
  openDialog: () => {},
  closeDialog: () => {},
  agentConnected: true,
  isOpen: false,
};

// Exported so test utils can inject a stub value via Provider when they
// don't want the production WebSocket-driven context.
export const ClientRequiredDialogContext =
  createContext<ClientRequiredDialogContextType>(noopContext);

export const ClientRequiredDialogProvider = ({ children }: { children: ReactNode }) => {
  const { agentConnected } = useWebSocket();
  const [isOpen, setIsOpen] = useState(false);

  // Auto-close when the agent comes online — the user's reason for seeing
  // the dialog is gone, no point keeping it up.
  useEffect(() => {
    if (agentConnected && isOpen) setIsOpen(false);
  }, [agentConnected, isOpen]);

  const openDialog = useCallback(() => setIsOpen(true), []);
  const closeDialog = useCallback(() => setIsOpen(false), []);

  const requireDesktopClient = useCallback(() => {
    if (agentConnected) return true;
    setIsOpen(true);
    return false;
  }, [agentConnected]);

  return (
    <ClientRequiredDialogContext.Provider
      value={{ requireDesktopClient, openDialog, closeDialog, agentConnected, isOpen }}
    >
      {children}
    </ClientRequiredDialogContext.Provider>
  );
};

export const useRequireDesktopClient = () => useContext(ClientRequiredDialogContext);
