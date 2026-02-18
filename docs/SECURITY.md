# Security Architecture

## Credential Management (Sealbox)

Sealbox encrypts sensitive user credentials (e.g., LinkedIn passwords) using libsodium.

-   **Device-Specific Keys**: Each deployment or developer machine generates a unique X25519 key pair via libsodium.
-   **Public Key Encryption**: The frontend receives only the public key (`VITE_CRED_SEALBOX_PUBLIC_KEY_B64`). Credentials entered by the user are encrypted in the browser before being sent to the backend.
-   **Private Key Decryption**: The private key resides only on the secure backend server (Puppeteer instance) and is never exposed to the client.
-   **Just-in-Time Decryption**: Credentials are decrypted only at the moment they are needed for authentication and are kept in memory for the shortest possible duration.

## Authentication & Authorization

-   **AWS Cognito**: Used for user identity management. All users must authenticate via Cognito User Pools to access the application.
-   **JWT Tokens**: Secure JSON Web Tokens are used to authorize API requests to the backend.
-   **API Gateway Authorizers**: Lambda authorizers verify tokens before allowing access to backend resources.

## Data Isolation

-   **DynamoDB Partitioning**: User data is isolated at the database level using partition keys derived from the user's Cognito `sub`. This ensures that users can only access their own data.

## Best Practices

-   **No Secrets in Frontend**: API keys and secrets are never stored in frontend code or `VITE_` environment variables.
-   **HTTPS/TLS**: All communication between the frontend, API Gateway, and backend services is encrypted in transit using TLS.
-   **Least Privilege**: IAM roles for Lambda functions are scoped to the minimum necessary permissions.
