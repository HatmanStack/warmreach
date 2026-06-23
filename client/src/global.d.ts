/**
 * Type-safe global bridges set by `electron-main.js` and consumed by
 * Express handlers in `src/server.ts`. The Express server runs in the
 * same Node process, so we hand tokens straight across rather than
 * through IPC.
 *
 * Setting these via module augmentation rather than inline casts in
 * server.ts means callers get real type-checking on the payload shape.
 */

export {};

declare global {
  interface AgentAuthSyncPayload {
    idToken: string;
    refreshToken: string;
    cognitoClientId: string;
    region: string;
  }

  var warmreachAuthSync: ((payload: AgentAuthSyncPayload) => void) | undefined;
  var warmreachAuthClear: (() => void) | undefined;
}
