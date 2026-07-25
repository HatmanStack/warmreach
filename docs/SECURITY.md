# Security Architecture

## Credential Management

The desktop client stores two kinds of secret: the user's LinkedIn credentials
and their Cognito session tokens. Both are sealed the same way.

LinkedIn credentials additionally take one of two independent paths into the
client. They are alternatives, not layers — a credential protected by one is
not also protected by the other.

### At Rest (Electron `safeStorage`)

Credentials saved in the desktop client's settings window are sealed with
Electron's `safeStorage`, which is backed by the OS keychain — Keychain on
macOS, DPAPI on Windows, libsecret/kwallet on Linux.

- **No application-held key**: the sealing key belongs to the OS keyring, so
  there is no secret in the source tree that could unseal a user's config.
- **Fails closed**: when no keyring is available (commonly a headless Linux
  box with no libsecret provider), the client **refuses to store credentials**
  and tells the user how to fix it, rather than silently writing a password to
  disk in the clear.
- **Migration**: a pre-`safeStorage` plaintext record is re-sealed
  transparently on first read. If it cannot be sealed, reads still work so the
  user is not stranded, but the client logs a prominent warning.
- **Covers session tokens too**: the Cognito ID and refresh tokens are sealed
  with the same mechanism. A token that cannot be sealed is simply not
  persisted, so the user signs in again next launch — unlike LinkedIn
  credentials, that is a recoverable inconvenience rather than a reason to
  block the save.
- **No static key**: the client previously opened electron-store with
  `encryptionKey: 'warmreach-local-v1'`, a constant in this publicly mirrored
  repository. That option is gone. The store file is plain JSON and each secret
  inside it is sealed individually.
- **One-time migration**: on first launch after upgrading, the legacy
  `config.json` is read with the old key, its secrets are sealed, and the result
  is written to `settings.json` before the old file is removed. When no keyring
  is available the migration is skipped — rewriting secrets into a plain file
  would be worse than leaving them obfuscated.

### In Transit (Sealbox)

Sealbox encrypts credentials that travel to the client inside a command payload,
using libsodium.

- **Device-Specific Keys**: Each deployment or developer machine generates a unique X25519 key pair via libsodium.
- **Public Key Encryption**: The frontend receives only the public key (`VITE_CRED_SEALBOX_PUBLIC_KEY_B64`). Credentials entered by the user are encrypted in the browser before being sent to the backend.
- **Private Key Decryption**: The private key resides only on the secure backend server (Puppeteer instance) and is never exposed to the client.
- **Just-in-Time Decryption**: Credentials are decrypted only at the moment they are needed for authentication and are kept in memory for the shortest possible duration.

## Authentication & Authorization

- **AWS Cognito**: Used for user identity management. All users must authenticate via Cognito User Pools to access the application.
- **JWT Tokens**: Secure JSON Web Tokens are used to authorize API requests to the backend.
- **API Gateway Authorizers**: Cognito JWT authorizers verify tokens before allowing access to backend resources.
- **WebSocket Access-Log Redaction**: The WebSocket API stage uses a custom access log format that deliberately omits `$context.requestQueryString`. The `$connect` route accepts the JWT via `?token=`, and logging the raw query string would leak bearer tokens to CloudWatch. Only non-sensitive routing and diagnostic fields (requestId, source IP, routeKey, status, connectionId) are logged.

## Data Isolation

- **DynamoDB Partitioning**: User data is isolated at the database level using partition keys derived from the user's Cognito `sub`. This ensures that users can only access their own data.

## Anti-Fingerprinting

The Puppeteer automation client includes layered mitigations to reduce browser fingerprint detection:

1. **Stealth plugin** — `puppeteer-extra-plugin-stealth` patches common automation leaks (webdriver flag, chrome.runtime, navigator properties, etc.)
2. **Automation flag suppression** — `--disable-blink-features=AutomationControlled` and `ignoreDefaultArgs: ['--enable-automation']` remove Chrome's built-in automation indicators
3. **System Chrome detection** — Uses locally installed Chrome/Chromium instead of bundled Chromium when available, producing a more realistic TLS and browser fingerprint
4. **Request interception** — Blocks `chrome-extension://` requests to prevent extension enumeration
5. **Fingerprint noise injection** — Canvas (RGB pixel noise on a cloned canvas), WebGL (randomized GPU vendor/renderer from a pool of modern profiles), and AudioContext (micro-noise on rendered buffers) scripts are injected via `evaluateOnNewDocument`
6. **Mouse simulation** — Human-like cursor movement along bezier-curved paths before element clicks

All mitigations are independently toggleable via environment variables (see [CONFIGURATION.md](CONFIGURATION.md)).

## Best Practices

- **No Secrets in Frontend**: API keys and secrets are never stored in frontend code or `VITE_` environment variables.
- **HTTPS/TLS**: All communication between the frontend, API Gateway, and backend services is encrypted in transit using TLS.
- **Least Privilege**: IAM roles for Lambda functions are scoped to the minimum necessary permissions.
