# Changelog

All notable changes to WarmReach will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Backend:** B-2 "Open Claw" autonomous opportunity agent — `opportunity-agent`
  control plane (`POST /opportunity-agent`), the `agent-action-task` Step Functions
  workers (gate-dispatch → confirm → dependency → await-confirmation), and the
  `AgentActionStateMachine`. Actions claim-before-send and meter against a shared
  `li-actions` quota bucket, so a real LinkedIn action is dispatched and metered
  exactly once.
- **Backend:** `linkedin-action-gate` (`POST /linkedin-actions`) — quota-gated
  dispatch for user-initiated LinkedIn actions, metered against the same
  `li-actions` bucket as the agent (free tier 20/day, 200/month).
- **Backend:** `opportunity-reconciler` — scheduled EventBridge sweep of stuck
  agent actions and research, backed by a sparse reconciliation GSI (query, not
  table scan).
- **Backend:** `digest-unsubscribe` (`GET /unsubscribe`) — one-click,
  HMAC-validated weekly-digest unsubscribe.
- **Backend / Frontend:** Warm-intro pathways — a per-user contact-to-contact
  adjacency mesh and BFS pathfinding that surface warm introduction paths.
- **Docs:** ADR-009 — the command-dispatch community-clean boundary
  (agent/quota-agnostic core, quota reserved in the gates).
- **CI:** `scripts/check-doc-tables.py` — a doc-table parity gate that fails when
  the Lambda or shared-service tables in `CLAUDE.md` / `docs/ARCHITECTURE.md`
  drift from `template.yaml` and `shared_services/`.

### Changed

- **Backend:** Split the 954-line `analytics-insights` Lambda into five
  bounded-context deploy units (`analytics-insights`, `opportunities`,
  `opportunity-agent`, `goal-intelligence`, `network-intelligence`) with scoped
  IAM — only `opportunity-agent` carries `states:*`.
- **Backend:** Collapsed the gate → `command-dispatch` Lambda hop into an
  in-process shared `command_dispatch_core` call (ADR-009), removing a
  Lambda-to-Lambda network hop from the LinkedIn send path while preserving the
  claim-before-send and fail-closed metering invariants.
- **Backend:** Reconciler now queries a sparse GSI for stuck rows instead of
  scanning the table; agent confirmation polling backs off (30s → 5min).
- **Backend:** Added an explicit `VALID_TRANSITIONS` FSM matrix to the agent
  action lifecycle, typed + guarded SFN task-event boundaries, and explicit
  timeouts on the remaining cross-Lambda invoke clients.

### Fixed

- **Backend:** `PAID_TIER_FEATURES` was missing `opportunity_agent`, so paid
  users defaulted to `False` on the flag and were gated out of the agent. Added
  the flag with a parity guard that every free-tier flag key is present on the
  paid tier.
- **Hygiene:** Declared the `domhandler` dependency, removed the orphaned
  `backend/uv.lock` stub, pruned dead barrel re-exports and duplicate default
  exports, and silenced knip false positives.

### Docs

- **Docs:** Described the `llm` Lambda as OpenAI-only (Bedrock scoped to RAGStack
  embeddings); documented `POST /linkedin-actions`, `GET /unsubscribe`,
  `GET /client-downloads`, and the four split routes; documented the B-2 agent
  env vars, the `opportunity_agent` feature flag, and the `li-actions` metered
  bucket; relabeled the `COMMAND#` item lifecycle (not a state machine) and
  documented the real `AgentActionStateMachine`; and dropped the stale
  `edge-processing` name from the community overlays.

## [1.20.0] - 2026-06-23

Audit remediation: a unified pass over three audits (technical-debt health, 12-pillar
code evaluation, documentation drift) sequenced as cleanup, then reliability fixes,
then guardrails, then documentation.

### Added

- **CI:** Python static type checking (`npm run typecheck:backend`, mypy over the backend
  `shared_services` layer) and lint rules that reject untyped WebSocket command payloads
  and double-casts at the transport boundary.
- **Docs:** Generated API reference — `npm run docs:api:ts` (typedoc for frontend/client/admin)
  and `npm run docs:api:py` (mkdocstrings for the backend shared-services layer). Output is
  generated in CI and gitignored. A `docs-api.yml` workflow keeps both generators buildable.

### Changed

- **Frontend:** Reliability hardening — wired the existing `ErrorBoundary`, added `Suspense`
  boundaries, fetch timeouts via `AbortController`, and `setTimeout` cleanup; memoized
  chart/table/list components with stable list keys.
- **Backend:** Consistent error-handling posture on the LLM/billing paths (narrowed broad
  excepts, fail-closed on quota) and a uniform OpenAI retry wrapper.
- **Client:** Typed the `commandRouter` transport boundary and persisted the LinkedIn
  daily-action rate limit via the existing Redis path.
- **Admin:** Admin routes gate on the admin role, not merely authentication.
- **CI:** `docs-lint` (markdownlint + lychee) is now a blocking PR gate instead of
  `continue-on-error`.
- **Client:** Moved the LinkedIn auth lifecycle into the interaction service
  (`ensureAuthenticated`), removing the constructor-cast workaround in the controller.
- **Client:** Typed the profile-init and search controllers (removed the remaining
  `any`/double-cast escapes) and extended the transport-boundary lint ratchet to cover them.

### Fixed

- **Docs:** Corrected the `BEDROCK_MODEL_ID` drift (the real default is
  `us.anthropic.claude-sonnet-4-5-20250929-v1:0`), removed the stale `registration`-Lambda
  sections, documented the `client-downloads` Lambda and `protocols.py` shared service,
  fixed the admin dev-server command, the `WebSocketApiUrl` output-key comment, and the
  shared-services path. `scripts/deploy/get-env-vars.sh --update-env` now also writes
  `VITE_WEBSOCKET_URL`, matching the docs.
- **Client:** A failed Puppeteer initialisation now closes the launched Chromium instead of
  orphaning it (the self-healing restart loop was leaking one browser per cycle).
- **Client:** WebSocket client gained heartbeat-liveness detection (half-open sockets now
  reconnect), jittered reconnect backoff, and listener cleanup on reconnect.
- **Backend:** `digest-per-user` SES sends retry transient failures with a bounded timeout
  and log delivery failures distinctly instead of swallowing them.
- **Frontend:** A failed initial profile fetch no longer suppresses retries for the whole
  session — the error surfaces and the fetch can retry.
- **Client:** Search `successRate` guards against division by zero (no more `NaN%`).

### Security

- **Frontend:** Sign-out invalidates the Cognito refresh token server-side (`globalSignOut`)
  and purges the cached tokens from `localStorage` instead of clearing an unused key.
- **Client:** The LinkedIn daily-action rate limiter fails closed when its configured Redis
  backend errors, rather than falling back to a fresh in-memory counter that could exceed
  the daily cap.
- **Client:** The WebSocket transport boundary validates command payloads (typed shapes and
  boolean feature-flag values) before dispatching to browser automation.
- **Dependencies:** Cleared client `npm audit` high-severity advisories (fast-uri, form-data,
  node-tar, tmp, undici) and backend test-dependency advisories (PyJWT, urllib3, cryptography,
  idna).

## [1.19.0] - 2026-04-29

### Fixed

- **Client:** `app.requestSingleInstanceLock()` — launching the AppImage a second time now focuses the existing window instead of spawning a duplicate. Without this, two agent processes held the same Cognito token, both connected as `clientType=agent`, and the backend's "single client per user per type" rule put them in a permanent reconnect loop.

## [1.18.0] - 2026-04-29

### Changed

- **Client:** Removed the manual "Cognito ID token" paste field from the settings window. The web-app "Connect Desktop Agent" button (loopback POST + auto-refresh) is the only sign-in flow; the paste UI was a stopgap and is now redundant.

## [1.17.0] - 2026-04-29

One-click desktop-agent sign-in: the web app now hands its Cognito tokens straight to the local agent over loopback, and the agent refreshes them automatically.

### Added

- **Client:** `POST /auth/token` route on the local Express server accepts `{idToken, refreshToken, cognitoClientId, region}` from the web app, persists them to electron-store, and (re)opens the cloud WebSocket immediately. CORS allow-list now bakes in the production Amplify origin.
- **Client:** Cognito refresh-token loop — every 50 minutes the agent calls `InitiateAuth` with `REFRESH_TOKEN_AUTH` to mint a fresh id token and reconnects the WS. Refresh failure with HTTP 400 (refresh token expired) clears stored creds so the UI returns to "Sign in to connect".
- **Frontend:** `ConnectDesktopAgentButton` on the Profile page — single click pushes Cognito tokens to `localhost:3001/auth/token` so the agent's status pill flips to "Connected" without leaving the browser.
- **Backend:** `agent_status` WebSocket message — `$connect` broadcasts to existing browsers when an agent connects, `$default` answers `get_agent_status` requests so freshly-opened browsers can query current state without waiting for an agent event.

### Fixed

- **Backend:** `$connect` no longer posts to the in-flight WebSocket connection (the API Gateway handshake isn't complete there, so `post_to_connection` returned 410 and the GoneException handler tore down the still-valid record). The dashboard now correctly tracks agent presence.
- **Backend:** `analytics-insights` and `ragstack-ops` Lambdas now declare `requests` in `requirements.txt` — both transitively import shared services that use it, so omitting the dep crashed the Lambda with `ModuleNotFoundError` whenever the save-profile flow triggered the analytics call.
- **Frontend:** `UserProfileContext.updateUserProfile` throws when `useAuth().user` is null instead of silently returning. The Save Profile path was reporting "Profile updated!" while no API call ever fired.
- **CI:** `release.yml` calls `electron-release.yml` directly via `workflow_call` instead of relying on `release: types: [published]` (which never fires when `GITHUB_TOKEN` creates the release). `sync-public.yml` allows `CHANGELOG.md` so new releases sync to the community repo.

### Changed

- **Frontend:** "Add Contact" button on the connections tab uses the same `bg-white/10` glass styling as the surrounding chrome instead of `variant="outline"`, which was bleeding a light background through the dark card.

## [1.16.0] - 2026-04-29

Release pipeline fix: AppImage now publishes automatically when a new release is cut.

### Fixed

- **CI:** `release.yml` now invokes `electron-release.yml` via `workflow_call` instead of relying on the `release: types: [published]` event, which silently no-opped when `GITHUB_TOKEN` created the release (GitHub anti-loop protection). v1.15.0 shipped with zero AppImage assets because of this.
- **Client:** `electron:build` script passes `--publish never` to electron-builder so CI detection no longer triggers implicit publishing (which then errored on missing `GH_TOKEN`).

## [1.15.0] - 2026-04-28

Desktop client ready for distribution: buildable Linux AppImage, ChromeOS-compatible control window, and CI pipeline that publishes artifacts to the public release.

### Added

- **Client:** Linux AppImage build pipeline — `tsconfig.build.json` + `scripts/copy-emitted.mjs` compile TypeScript sources to JavaScript at package time so `.ts`-imports resolve inside the asar
- **Client:** Control window UI (`src/window/main.html`, `mainPreload.ts`) — status pills (WebSocket, automation, threat level), backend port, and buttons for Open WarmReach / Settings / Check for Updates / Pause-Resume / Quit. Always opens on launch; on tray-capable platforms doubles as a quick status pane, on platforms without tray (ChromeOS Crostini, headless Linux) it's the only UI and closing quits the app
- **Client:** Production WebSocket + Amplify defaults baked into `electron-main.js` (still env-overridable via `WARMREACH_WS_URL` / `WARMREACH_APP_URL`)
- **Client:** App icon wired into both BrowserWindows so the title bar shows the WarmReach mark instead of the platform default
- **CI:** `.github/workflows/electron-release.yml` — fires on release publish, builds the AppImage on `ubuntu-latest`, waits for `release-sync.yml` to create the matching release on `HatmanStack/warmreach`, then uploads `WarmReach-Agent-${version}.AppImage` + `latest-linux.yml`. Reuses the existing `WARMREACH_PUBLIC_PAT` secret. `workflow_dispatch` form supports backfilling artifacts on past tags

### Fixed

- **Client:** `app.use('*', ...)` 404 handler in `src/server.ts` rewritten as a no-path middleware — Express 5 + path-to-regexp v6 reject the bare `*` wildcard, which crashed the packaged app at startup
- **Client:** `import { autoUpdater } from 'electron-updater'` — `electron-updater` is CommonJS, switched to default import + destructure
- **Client:** Three route files (`searchRoutes.js`, `profileInitRoutes.js`, `linkedinInteractionRoutes.js`) used default imports against controllers that export named classes; tsx tolerated the mismatch in dev but Node ESM rejected it in the packaged build
- **Client:** `uncaughtException` handler in `src/server.ts` writes the stack synchronously to stderr before `process.exit(1)` so errors actually surface (winston is async and was being killed before it flushed)
- **Client:** `autoUpdater.logger = null` — silences electron-updater's built-in stack-trace logging when the GitHub release isn't there yet (we surface failures via the dialog instead)

### Changed

- **Client:** Settings window no longer exposes the WebSocket URL field — operators self-deploying configure via env var; end users never need to touch it
- **Client:** `electron-builder.yml` `files:` includes `config/`, `routes/`, `schemas/`, and `electron-resources/`; excludes `*.ts` source from the final asar

Second audit remediation (plan: `2026-04-23-audit-warmreach-pro`). Full adversarial pipeline across 6 phases produced a VERIFIED verdict.

### Fixed

- **Security:** command-dispatch wraps `json.loads` in try/except — malformed JSON body returns 400 instead of unhandled 500
- **Security:** Redis rate-limiter INCR + EXPIRE collapsed into an atomic Lua script — closes TOCTTOU gap at window-boundary expiry
- **Security:** `DEV_MODE=true` emits a warn-once log on activation so a misconfigured prod environment is surfaced
- **Security:** websocket-connect logs a startup warning when `COGNITO_CLIENT_ID` is unset (cross-application JWT reuse check was silently skipped)
- **Security:** Pin `nahuelnucera/ministack` CI image to `sha256:499c135a…bc6f7bc6` for supply-chain parity with SHA-pinned GitHub Actions
- **Backend:** Quota rollback — decrement daily counter when the monthly step fails, so a user at `daily=N monthly=CAP` no longer permanently bleeds a daily unit per failed request
- **Backend:** command-dispatch status flow is transactional — `TransactWriteItems` binds the rate-limit increment to the command-record write
- **Backend:** `_handle_summarize_evidence` routes through `svc._openai_responses_create` + `@wrap_llm_errors` so transient OpenAI errors get the shared retry / error-mapping path
- **Backend:** Narrow `wrap_llm_errors` from `BaseException` to `Exception` — `SystemExit` / `KeyboardInterrupt` / `GeneratorExit` propagate untouched
- **Backend:** Frontend `VITE_API_TIMEOUT_MS` fallback corrected (was 27 h, now 30 s)
- **Backend:** Add request timeouts to RAGStack GraphQL client
- **Backend:** Retry transient OpenAI errors with exponential backoff
- **Backend:** LLM reserves quota before OpenAI call (closes cost-leak window on client cancellation)
- **Backend:** WebSocket `$default` and `$disconnect` wrapped in top-level try/except with correlation context
- **Backend:** Opportunity-tag retry bounded with exponential backoff
- **Backend:** Stripe webhook idempotency TTL extended from 7 days to 90 days
- **Backend:** Fire-and-forget paths log errors before swallowing
- **Backend:** circuit-breaker `set_state` stays best-effort on non-`ClientError`
- **Backend:** Error response schema normalized across handlers
- **Backend:** command-dispatch fixed-window rate-limit semantics documented (2× burst at window boundary is an accepted tradeoff)
- **Client:** Puppeteer `launch()` wrapped with 30 s timeout
- **Client:** Async logger with bounded queue replaces `fs.*Sync` + unbounded memory
- **Client:** In-memory rate-limiter map bounded with periodic prune
- **Client:** Redundant per-request cleanup in `rateLimiter.ts` removed (interval covers it)
- **Client:** `asOpsContext` renamed to `unsafeAsOpsContext` so the `as unknown as` escape hatch is explicit at call sites

### Added

- **Backend:** `shared_services/protocols.py` — typed `Protocol` definitions for `handler_utils` service DI (`QuotaServiceProto`, `FeatureFlagServiceProto`, `HandlerFn`, `ServiceResolver`)
- **Backend:** `tests/backend/unit/test_cold_start_imports.py` — subprocess-based import ceilings per hot Lambda to lock in Phase-4 cold-start gains
- **Backend:** `tests/backend/unit/test_monetization_parity.py` — locks pro / stub public surface (exports + method signatures)
- **Backend:** `parse_days` helper in `handler_utils.py` (removes 25+ duplications across analytics-insights handlers)
- **Backend:** `parallel_scan` helper in `handler_utils.py` — `admin-metrics` full-table and tier scans plus `digest-coordinator` paid-users scan use `TotalSegments`
- **Backend:** Shared services lazy-imported via PEP 562 `__getattr__` — bounded cold-start graph on `analytics-insights`, `edge-crud`, `ragstack-ops`
- **Platform (SAM):** X-Ray tracing enabled globally (`Tracing: Active`)
- **Platform (SAM):** DLQs + CloudWatch alarms on every async-invoked Lambda
- **Platform (SAM):** Reserved concurrency on `command-dispatch` and `llm`
- **Platform (SAM):** p99 duration and throttle alarms for hot Lambdas
- **Platform (SAM):** WebSocket connect caches Cognito JWKS (6 h TTL, 24 h stale grace, 2 s fetch timeout, single retry)
- **Platform (SAM):** API Gateway access-log format redacts `queryStringParameters.token`
- **CI:** Coverage floors wired for frontend, client, and admin Vitest workspaces at current baselines
- **CI:** `scripts/check-overlay-drift.sh` — pull-request gate across the 64-entry `.sync/config.json overlay_mappings`
- **CI:** `scripts/check-skipped-tests.sh` — `.skip` / `xit` / `@pytest.mark.skip` require `TODO(#NNN)` or issue/PR URL on the same or previous line
- **CI:** `docs-lint.yml` — markdownlint-cli2 + lychee, non-blocking initially (flip-required target 2026-04-30)
- **Frontend:** `Dashboard.tsx` smoke test (renders, tabs, sign-out)
- **Docs:** 8 ADRs formalized with canonical numbering — SSRF-safe URL validation, conversion-likelihood classification, RAGStack rate-limit sleep, SSM-backed secret TTL cache, followup default thresholds, JWT signature-not-verified tradeoff, client-side filtering for non-ingested connections, browser-side timezone auto-detection
- **Docs:** `docs/DEVELOPMENT.md` bash fix, `docs/API_REFERENCE.md` tier-marker legend, `docs/CONFIGURATION.md` Cognito parity / RAGStack per-Lambda / `VITE_AWS_REGION` optional / `VITE_API_TIMEOUT_MS` / feature-flag catalog (28 flags), `docs/DEPLOYMENT.md` Bedrock region caveat + SAM parameter table with `RagstackGraphqlEndpoint` / `RagstackApiKey` / `AdminUserSub`, `docs/TROUBLESHOOTING.md` WebSocket (6 failure modes), admin, environment-parity sections
- **Docs:** `docs/plans/README.md` status index across every dated plan folder
- **Hygiene:** Removed tracked `.coverage` / `linkedin-inspect.log` artifacts and `electron-release.yml.disabled`

### Changed

- **Backend:** `handler_utils.py` service-DI signatures use `Protocol` types instead of `Any`
- **Backend:** `LLMService._openai_responses_create` is the single OpenAI retry entry point; `_summarize_evidence_openai_call` routes through it
- **Backend:** circuit-breaker `.state` docstring documents that `open -> half_open` is race-safe only under a single-threaded executor
- **Client:** `search` and `profile` controllers fully typed (drop `unknown` casts in LinkedIn service DI)
- **Frontend:** `posts` service response schema-validated

Initial cloud deployment of the platform: SAM backend hardening, frontend build unblock + Tailwind v4 migration, on-device LinkedIn credentials architecture (never transmitted), and a centralized desktop-client gate that prompts for download whenever an automation action is attempted without the agent running.

### Added

- **Deploy:** `scripts/deploy/deploy-sam.js` — interactive backend deploy with `us-east-1` region pin, SSM SecureString flow for OpenAI/Stripe/Stripe-webhook secrets (passes ARNs as template params), and pre-flight checks (AWS creds, SAM CLI, Docker, Bedrock model access, SES verified-identity status, Lambda concurrency headroom). Captures stack outputs into root `.env`, `frontend/.env`, and `admin/.env`.
- **Deploy:** `scripts/deploy/teardown.sh` — idempotent teardown that discovers warmreach resources dynamically (Cognito, DynamoDB, S3, S3 Vectors, IAM CloudWatch role orphans, the CFN stack) and handles versioning-enabled buckets via explicit version + delete-marker cleanup. Wired as `npm run teardown` / `npm run teardown:dry`.
- **Backend:** `lambdas/client-downloads/` Lambda + `/client-downloads` HTTP route — public endpoint returning per-platform desktop-client download URLs from `ClientDownload{Mac,Win,Linux,Version}Url` template parameters. Accepts both `https://` (pass-through) and `s3://bucket/key` (mints 5-min presigned URL on each request). Operators swap hosting locations by re-running `npm run deploy` without a frontend rebuild.
- **Frontend:** `<DesktopClientDownloadPrompt />` (`features/profile/components/`) — fetches `/client-downloads`, detects platform from `navigator.userAgent`, surfaces native binary as primary CTA with the others as fallbacks. Empty platforms render "(coming soon)" disabled buttons.
- **Frontend:** `<ClientRequiredDialogProvider>` + `<ClientRequiredDialog>` + `useRequireDesktopClient()` (`shared/contexts/`, `shared/components/`) — centralized gate that opens a modal whenever a Puppeteer-dependent action is attempted without the desktop agent running. Auto-closes when `agentConnected` flips true. Mounted once at the app root inside `WebSocketProvider`.
- **Frontend:** `useCommand` gained a `silent` option for background/auto-fire dispatches that should fail quietly instead of popping the modal. `ConnectedAccounts.statusCommand` (background GitHub-status poll) opts in.
- **Platform (SAM):** Account-level CloudWatch Logs role + `AWS::ApiGateway::Account` config — the one-time per-account setting required for any API Gateway access logging (v1 or v2). Retained on stack delete so other stacks in the same account keep their logging.
- **Platform (SAM):** `EnableDigests` parameter (default `false`) gates digest Lambdas + their EventBridge schedules so first deploys don't immediately start firing.
- **Platform (SAM):** `RagstackTemplateUrl` parameter — defaults to the public RAGStack quicklaunch bucket, swappable per-deploy. Replaces the hardcoded account-suffixed URL that never had a publish pipeline behind it.

### Fixed

- **Deploy:** `samconfig.toml` capabilities now `CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND` (was missing `_NAMED_IAM` and `_AUTO_EXPAND` — first deploy failed at changeset creation).
- **Deploy:** SAM-deploy bucket name includes the account ID (`sam-deploy-warmreach-{account}-{region}`) so multiple deployers in different accounts don't collide on the global S3 namespace.
- **Deploy:** External-RAGStack path (`DeployRAGStack=false`) prompts for `RagstackGraphqlEndpoint` + `RagstackApiKey` (was silently skipped, deploy ran with empty values).
- **Deploy:** Bedrock-access pre-flight queries `list-inference-profiles --type-equals SYSTEM_DEFINED` for `us.*` cross-region IDs with fallback to `list-foundation-models`.
- **Deploy:** SES-sandbox warning only fires when the identity isn't verified (was firing on every run).
- **Deploy:** Post-deploy `update-function-configuration` for `admin-metrics` reads existing env vars and merges `HTTP_API_ID` instead of replacing the whole block — no longer wipes `ALLOWED_ORIGINS` / `DYNAMODB_TABLE_NAME` injected by SAM Globals.
- **Platform (SAM):** Removed duplicate `SharedPythonLayer` reference on `WebSocketConnect/Disconnect/Default` and `CommandDispatch` Lambdas (was listed in both `Globals.Function.Layers` and per-function — Lambda rejected create with "Two different versions of the same layer").
- **Platform (SAM):** `AdminMetricsFunction` no longer references `!Ref HttpApi` in `Environment.Variables` — that ref produced a circular dependency with `HttpApi` / `HttpApiStage` once `HasAdmin` flipped true. Deploy script populates `HTTP_API_ID` post-deploy via `update-function-configuration`.
- **Platform (SAM):** Bedrock model defaults updated from stale Llama 3.2 / Claude 3 Sonnet to `us.anthropic.claude-sonnet-4-5-20250929-v1:0` cross-region inference profile in both pro and community templates and the `llm_service.py` runtime fallback.
- **Backend:** `request_utils.py` strips trailing slashes from `ALLOWED_ORIGINS` entries — browsers never include them in the `Origin` header but operators frequently paste URLs with one.
- **Backend:** Globals `ALLOWED_ORIGINS` `!Sub` expression had a missing comma between `localhost:3000` and `${ProductionOrigins}`, producing concatenated origin strings like `localhost:3000https://...`.
- **Backend:** `admin-metrics` Lambda short-circuits OPTIONS preflight to 204 before the auth check (was returning 403 for valid CORS preflights from authorized origins).
- **Frontend (admin):** `apiClient.ts` URL join normalizes leading/trailing slashes, fixing `…/prodadmin/metrics` (missing slash) when `VITE_API_GATEWAY_URL` ends in `/prod`.
- **Frontend:** Build unblocked — `tsc -b` excludes tests + `test-utils` from the production typecheck (vitest has its own quality gate); 66 strict-mode source errors fixed (`noUncheckedIndexedAccess` violations, Lambda-proxy response unwrap casts, `Record<string, unknown>` index-signature mismatches, optional-to-required type drift).
- **Frontend:** Tailwind v3 → v4 CSS-first migration — `@import "tailwindcss"` + `@theme` block in `src/index.css`, swap `tailwindcss-animate` (v3-only) for `tw-animate-css` (v4-native), delete `tailwind.config.ts`.
- **Frontend:** `usePendingDrafts` query gated on `isFeatureEnabled('comment_concierge')` so the LLM Lambda doesn't return 403 `FEATURE_GATED` on every Dashboard mount for tiers without the feature.
- **Hygiene:** Deleted stale `backend/scripts/deploy.js` (duplicate, missing capabilities, plaintext OpenAI key) and orphaned `backend/lambdas/registration/` (zero template references).

### Changed

- **Architecture:** LinkedIn credentials live exclusively on-device in the desktop client, encrypted with libsodium Sealbox. The cloud no longer accepts, returns, or stores them. The web app's role at credential entry is to direct the user to install the desktop client.
- **Backend:** `dynamodb-api` Lambda no longer accepts, returns, or validates `linkedin_credentials` (silently dropped from update payloads, omitted from get-profile responses).
- **Frontend:** `Profile.tsx` save flow only persists profile metadata (name, headline, company, etc.) — credential encryption + transmission removed. `<LinkedInCredentials />` form replaced with `<DesktopClientDownloadPrompt />`. `useLinkedInCredentials` hook + the credential-entry component deleted.
- **Frontend (onboarding):** `LinkedInCredentialStep` rewritten as a download prompt; users with an existing Sealbox ciphertext can advance immediately via "I already have it installed →".
- **Sync:** Community overlay `OpenAIApiKey` plaintext parameter switched to `OpenAIApiKeyArn` SSM SecureString pattern (matches pro). Community `llm/lambda_function.py` overlay updated to use `SSMCachedSecret` for key resolution. Removes the security-model regression where pro and community handled secrets differently.

## [1.13.0] - 2026-04-16

### Fixed

- **Security:** Replace `socket.getaddrinfo` DNS resolution in URL validation with parse-only SSRF check — eliminates Lambda thread blocking on DNS failures
- **Security:** Fix Redis rate limiter middleware bypass — `next()` was called after 429 response, allowing rate-limited requests through
- **Security:** Add optimistic concurrency (ConditionExpression) to EdgeOpportunityService tag/untag/stage operations — prevents duplicate entries from concurrent requests
- **Security:** Strengthen profile*id validation with proper base64url regex (`^[A-Za-z0-9*\-]+=\*$`)
- **Security:** Derive electron-store encryption key from machine-specific hash instead of static string
- **Backend:** Fix PAID_TIER_FEATURES missing 17 feature flags — new paid subscribers now receive all 27 flags (goal_intelligence, comment_concierge, portfolio_metrics, etc.)
- **Backend:** Cap notification `mark_all_read` at 500 items with per-item error handling to prevent Lambda timeout
- **Backend:** Lazy-init Bedrock client in LLM Lambda — eliminates unnecessary cold-start overhead for OpenAI-only operations
- **Backend:** Add explicit timeouts to 3 OpenAI `responses.create()` calls outside LLMService (summarize_evidence, goal_intelligence_service)
- **Backend:** Add 5-minute TTL to cached LLM service for API key rotation support
- **Backend:** Add ProjectionExpression to analytics dashboard queries — funnel/growth exclude message arrays, engagement uses targeted messages-only projection
- **Backend:** Eliminate circuit breaker double-read in `call()` — single `_get_local_state()` in common path
- **Backend:** Cache BillingService in dynamodb-api Lambda instead of per-request instantiation
- **Backend:** Scope SES IAM policy from `Resource: '*'` to verified sender identity ARN
- **Backend:** Increase circuit breaker DynamoDB store TTL from 1h to 24h to prevent silent reset
- **Backend:** Converge `os.environ` access pattern in dynamodb-api to use explicit RuntimeError
- **Backend:** Deduplicate GoalIntelligenceService construction via shared factory in handler_utils.py
- **Backend:** Cache OpenAI client in analytics-insights `_handle_generate_checklist` instead of creating fresh client per call
- **Frontend:** Replace `next-themes` (Next.js library) with native MutationObserver theme hook
- **Frontend:** Guard `VITE_MOCK_MODE` in production builds via Vite define
- **Frontend:** Replace unsafe `as unknown as T` cast in httpClient with null guard
- **Frontend:** Unify TierInfo type from shared types — remove local duplicate in TierContext
- **Client:** Fix `fileToGenerativePart` blocking `readFileSync` → async `readFile`
- **Client:** Fix typing pattern `randomInRange` always returning 1.2 for float multipliers — add `randomFloat()`
- **Client:** Fix graceful shutdown `process.exit(0)` firing before HTTP drain completes

### Added

- **Backend:** `EdgeOpportunityService` — extracted from EdgeDataService facade, completing decomposition
- **Client:** Full JS→TS migration: 33 source files converted across security, transport, config, and domain layers
- **Admin:** Test coverage expanded from 4 to 7 files (LoginPage, authService, apiClient)
- **CI:** Docs lint workflow with markdownlint and lychee link checking
- **Docs:** Sync overlay development guide in DEVELOPMENT.md
- **Docs:** 13 missing shared services added to ARCHITECTURE.md and CLAUDE.md tables
- **Docs:** All API operations documented (19 POST + 2 GET for DynamoDB API, 14 LLM, 5 analytics goal intelligence)
- **Docs:** DEPLOYMENT.md parameter name corrected (OpenAIApiKeyArn), AlarmNotificationEmail documented
- **Docs:** Missing env vars added to CONFIGURATION.md (GITHUB_CLIENT_ID/SECRET, VITE_STRIPE_PRO_PRICE_ID, VITE_TELEMETRY_ENDPOINT)

### Changed

- **Backend:** Enable Ruff G004 rule — 148 f-string logging calls converted to lazy `%s` formatting across 35 files
- **Backend:** `_query_all_edges` accepts optional `projection` and `expression_attribute_names` parameters
- **Frontend:** `vite.config.ts` uses function form for mode-dependent define

## [1.12.0] - 2026-04-14

### Added

- **Comment Concierge:** Electron scrapes LinkedIn feed, filters Tier-1 posts (automated: score 70+ or opportunity-linked, manual: user-tagged, off), LLM generates 3 draft comments per post, user reviews and approves in frontend, Electron posts via Puppeteer. Three-mode setting in profile settings. Feature flag: `comment_concierge`
- **Proactive Follow-up:** Cold connection detection (high overall score, low recency sub-score) integrated into weekly digest. Multi-action suggestions (comment on post, react, send message, engage with content) — action type selected based on connection context. Feature flag: `proactive_followup`
- **Network Pulse:** Cluster-seeded RAGStack queries surface trending topics from the user's network. 7-day DynamoDB cache. New "Trending in Your Network" section in weekly digest email. Feature flag: `network_pulse`
- **Enrichment Export:** Frontend-only JSON export alongside existing CSV. Pro fields include engagement tiers (score buckets), cluster tags, and interaction dates — computed at export time. Feature flag: `enrichment_export`
- **Multi-platform Contacts:** Manual "Add Contact" form with `source` field (linkedin/github/twitter/meetup/email/manual) on profile model. Backend support via `create_bad_contact_profile()`. Feature flag: `multi_platform_contacts`
- **Blog/Link Following:** During Comment Concierge feed scraping, external links are extracted, content is fetched with markdown conversion, and ingested into RAGStack. Feature flag: `blog_link_following`
- **Prompt Quality Feedback:** Thumbs up/down on goal assessments with optional "what was wrong?" text on thumbs down. `FeedbackService` stores ratings in DynamoDB with per-opportunity SK pattern. Feature flag: `prompt_quality_feedback`
- **Content Extractor:** Puppeteer-based HTML-to-markdown converter with article/main/density-based fallback for blog content extraction

### Changed

- **Architecture:** Feed scraper uses `waitForNetworkIdle` after scrolling for reliable infinite scroll loading
- **Architecture:** Tier-1 filtering matches by profile URL only (not display name) to prevent false positives
- **Backend:** `_handle_generate_comment` stores drafts in DynamoDB after LLM generation (generate → store in single operation)
- **Backend:** `get_pending_drafts` returns both `pending` and `posting_failed` drafts for retry visibility
- **Backend:** `FeedbackService` uses compound SK `FEEDBACK#{opportunity_id}#{timestamp}` for per-opportunity queries
- **Backend:** `store_drafts` uses conditional write (`attribute_not_exists`) to prevent overwrite on re-scrape
- **Backend:** Input validation for feedback ratings and draft status updates (400 instead of 200-with-error or 500)
- **Frontend:** Per-card approve/posting state instead of global `isPending` flag
- **Frontend:** Failed drafts shown with red border, warning message, and retry button
- **Client:** `postCommentDirect` throws on validation failure instead of returning error object
- **Client:** `LinkedInInteractionService` instantiated with `controlPlaneService` in post-comment handler
- **Client:** `userProfile` forwarded through command router → orchestrator → LLM for personalized comments
- **Client:** URL hashing uses SHA-256 instead of weak 32-bit hash for link dedup
- **Sync:** Updated LLM Lambda overlays, selector index overlay, RAGStack proxy overlay, command router overlay, and monetization stubs overlay for community edition

## [1.11.0] - 2026-04-12

### Added

- **Goal Intelligence:** Opportunities support rich goal context, evidence logs (manual + auto-detected + external APIs), and LLM-cached assessments with on-write pattern. Feature flag: `goal_intelligence`
- **Requirement Checklists:** LLM generates evolving checklists on goal creation with boolean/counter types, evidence linking, and `addedBy` tracking. Assessment returns `checklistUpdates` to mark items complete, add, modify, or remove requirements. User-added items protected from LLM removal
- **Notification System:** Generic `NOTIFICATION#` entity with severity levels (`info`/`warning`/`urgent`), WebSocket push, notification bell + drawer UI. Severity-based user preferences on Profile page
- **Cadence Alerts:** Agent-driven, goal-scoped alerts for tagged connections. Urgent pushes via WebSocket; warning/info surface in digest and in-app
- **Portfolio Metrics:** GitHub stars/forks/contributors/PRs via Electron polling with BrowserWindow OAuth. Token stored locally via `electron-store` — never leaves user's machine. New `client/src/domains/github/` domain
- **Digest Expansion:** "Goal Progress" and "Attention Needed" sections from cached assessments, no LLM calls at digest time
- **Evidence Summarization:** Capacity warning at 150+ entries, LLM-assisted "Summarize & Archive" with user preview dialog
- **Tabbed Opportunity Detail:** Connections | Evidence | Requirements | Assessment | Metrics tabs with modular Radix UI components
- **Domain-Aware Assessment Prompt:** Checklist output schema, evidence-to-requirement linking, reasoning guidance for certifications, career transitions, skill development, speaking/content goals

### Changed

- **Architecture:** GitHub OAuth moved from server-side Lambda to Electron BrowserWindow with localhost redirect interception, eliminating server-side token storage entirely
- **Architecture:** Portfolio metrics polling moved from EventBridge-triggered Lambda to Electron client WebSocket commands
- **Backend:** Assessment prompt includes `checklistUpdates` schema and domain-aware reasoning guidelines
- **Backend:** `NotificationService` checks user severity preference before WebSocket push
- **Backend:** `OpportunityService` extended with evidence, assessment, requirements, goal context, and capacity monitoring methods
- **Backend:** `GoalIntelligenceService` orchestrates evidence processing, checklist generation/mutation, and LLM assessment
- **Backend:** `GoalEvidenceDetector` auto-creates evidence from activity on opportunity-tagged connections (fire-and-forget)
- **Backend:** `mark_all_read` paginates across DynamoDB pages via `LastEvaluatedKey` loop
- **Backend:** `urlopen` in `GitHubClient` uses 30s timeout with `HTTPError`/`URLError` handling
- **Frontend:** `ConnectedAccounts` uses WebSocket commands to Electron instead of server-side OAuth URLs
- **Frontend:** Evidence links rendered as clickable anchors in timeline
- **Frontend:** Shared `_strip_fences()` helper extracts duplicated markdown fence-stripping logic

### Removed

- `backend/lambdas/oauth-callback/` — server-side OAuth callback Lambda (replaced by Electron BrowserWindow flow)
- `backend/lambdas/portfolio-metrics/` — server-side polling Lambda (replaced by Electron-side polling)
- `backend/lambdas/shared/python/shared_services/oauth_token_service.py` — server-side token storage (tokens now local-only)
- `axios` dependency from client (unused, critical vulnerability)

### Fixed

- GitHub OAuth token exchange includes `client_secret` (required by GitHub OAuth Apps)
- CSRF state nonce generated and verified in GitHub OAuth flow
- `event.preventDefault()` in OAuth redirect handler prevents `ERR_CONNECTION_REFUSED` flash
- `notificationSk` prefix validated before DynamoDB write to prevent arbitrary SK overwrites
- `GitHubApiService` cached on controller to preserve rate-limit state across polls
- Duplicate requirements data removed from LLM assessment prompt (was in both system prompt and user message)
- `import json` moved to module level in `opportunity_service.py`
- GitHub contributor count uses Link header pagination trick for accuracy (was always returning 0 or 1)

### Security

- `cryptography` upgraded 46.0.5 → 46.0.7 (CVE-2026-34073, CVE-2026-39892)
- Vite, lodash, path-to-regexp vulnerabilities resolved via `npm audit fix`
- Bandit `# nosec B310` added alongside Ruff `# noqa: S310` for `urlopen`
- Server-side OAuth token storage eliminated — GitHub tokens never leave user's machine

### Docs

- `PRO_FEATURES_ROADMAP.md` condensed: completed features summarized, follow-ups and scale-dependent items documented
- Plan documents: `docs/plans/2026-04-12-agentic-goal-intelligence/` and `docs/plans/2026-04-12-goal-intelligence-hardening/`

## [1.10.3] - 2026-03-27

### Changed

- **Architecture:** EdgeDataService (920 lines) decomposed into 5 focused sub-services (EdgeStatusService, EdgeMessageService, EdgeNoteService, EdgeQueryService, EdgeIngestionService) with thin facade preserving public API
- **Architecture:** LinkedInService accepts DynamoDBService via constructor injection instead of hard-instantiating
- **Performance:** Retry parameters tuned in ragstack_client.py and ingestion_service.py: max_retries 3->2, base delay 0.5s->0.3s (worst case 3.5s->0.9s)
- **Backend:** SSMCachedSecret extracted to shared_services/ssm_cache.py with TTL-based caching, replacing inline globals in LLM Lambda
- **Client:** All 7 `@ts-nocheck` files fully typed: linkedinConnectionOps, linkedinMessagingOps, linkedinProfileOps, linkedinPostOps, localProfileScraper, linkedinInteractionService, linkedinInteractionController
- **Client:** Fingerprint generation uses constrained sequential pool filtering (OS-to-GPU, device-to-resolution, browser-to-plugin compatibility maps) instead of independent random picks
- **Client:** Signal detector uses EMA-based variance tracking per domain with adaptive thresholds (`mean + N*stddev`) replacing static 4x/2x multipliers

### Fixed

- **Frontend:** postsService.test.ts mock drift: 2 failing researchTopics tests updated from `callProfilesOperation` to `httpClient.makeRequest`

### Added

- **CI:** `test-backend-integration` job with MiniStack service container, running in parallel with unit tests
- **E2E:** Playwright smoke tests for admin dashboard, billing/tier, network graph, and opportunities pages

### Docs

- 5 Lambda READMEs consolidated into ARCHITECTURE.md (LLM model routing, async research flow, registration lifecycle, WebSocket auth) and API_REFERENCE.md (command rate limiting)
- PRO_FEATURES_ROADMAP updated with all completed debt items

## [1.10.2] - 2026-03-27

### Changed

- **Architecture:** analytics-insights Lambda uses lazy `_get_service()` factory pattern, instantiating only the services needed per request instead of 14 at module scope
- **Architecture:** LinkedInService instantiation consolidated from 5 per-handler calls to 1 via `_ensureLinkedInAuth` helper
- **Performance:** GSI2 (inverted SK/PK index) added to DynamoDB template; digest-coordinator and admin-metrics use GSI queries with scan fallback
- **Performance:** LLM operation timeouts reduced (max 90s, down from 120s) with documented 30s margin budget
- **Performance:** Circuit breaker uses `CachedDynamoDBStore` with 5s TTL, reducing DynamoDB reads from 2-3 to ~1 per call
- **Performance:** ConnectionCard resize listeners consolidated into shared `useCharacterBudget` hook with 150ms debounce
- **Backend:** Bare `except Exception` blocks across 7 files narrowed to specific exception types (`TypeError`, `ValueError`, `json.JSONDecodeError`, `OSError`)
- **Backend:** `logger.error(str(e))` replaced with `logger.exception` in 11 Lambda handler top-level catches, preserving stack traces
- **Backend:** LLM input size validation gate (`MAX_INPUT_SIZE = 50_000`) returns 400 before dispatching to OpenAI
- **Backend:** BFS path accumulation bounded via `max_bfs_paths` parameter (default 50) in `warm_intro_paths_service.py`
- **Backend:** 14 new TypedDicts added to `dynamodb_types.py`; return type annotations added to `analytics_service`, `relationship_scoring_service`, `edge_data_service`, `quota_service`
- **Client:** Error handler registry pattern replaces string-matching `categorizeError` with `ERROR_PATTERNS` regex registry and `ERROR_CODES` fast path
- **Client:** 15 `.js` files migrated to `.ts` (8 fully typed, 7 with `@ts-nocheck` pending full annotation)
- **Client:** 13 silent catch blocks in `linkedinService.ts` now log errors with operation context
- **Client:** `any` types eliminated from all production `.ts` files (frontend and client)
- **Frontend:** `LambdaApiServiceFacade` removed (99-line pass-through); 16 production files updated to import specific services directly
- **Frontend:** Hardcoded confidence scores (`0.85`/`0.80`) removed from LLM responses; frontend field made optional

### Fixed

- **Backend:** Stripe webhook `getattr` dispatch now validates method existence with `hasattr`/`callable` guard before calling
- **Backend:** `_format_user_profile_context()` extracted as static method, replacing 4 duplicated inline loops in LLM service
- **Deps:** picomatch ReDoS, yaml stack overflow, brace-expansion vulnerabilities resolved via `npm audit fix`
- **Git:** `.env.docker` added to `.gitignore` and untracked

### Docs

- All `edge-processing` references replaced with `edge-crud`/`ragstack-ops`/`analytics-insights` across ARCHITECTURE.md, CLAUDE.md, API_REFERENCE.md, CONFIGURATION.md, DEPLOYMENT.md
- `handler_utils.py` added to shared services tables in ARCHITECTURE.md and CLAUDE.md
- `/analytics` endpoint documented in API_REFERENCE.md (23 operations)
- `OPENAI_API_KEY_ARN` replaces `OPENAI_API_KEY` in CONFIGURATION.md and .env.example
- Admin dashboard documented: `admin/README.md`, `admin/.env.example`, config section in CONFIGURATION.md
- Client stealth env vars (`ENABLE_HUMAN_BEHAVIOR`, `ENABLE_SUSPICIOUS_ACTIVITY_DETECTION`) documented in CONFIGURATION.md
- CONTRIBUTING.md `requirements-test.lock` reference corrected
- Broken relative link in Phase-3.md fixed

## [1.10.0] - 2026-03-27

### Changed

- **Security:** Restored OPENAI_API_KEY SSM SecureString pattern in template.yaml (OpenAIApiKeyArn parameter, ssm:GetParameter IAM policy) with 300s TTL cache in LLM Lambda
- **Architecture:** Monolithic edge-processing Lambda (819 lines, 41 operations) split into 3 focused Lambdas -- `edge-crud` (15 ops, 30s/256MB), `ragstack-ops` (3 ops, 30s/256MB), `analytics-insights` (23 ops, 45s/512MB) with per-domain resource tuning
- **Architecture:** Ingestion service converted to fire-and-forget -- removed `_wait_for_indexing()` polling loop and `time.sleep()` blocking; returns `status: 'submitted'` immediately
- **Architecture:** Edge writes use DynamoDB `TransactWriteItems` for atomic dual-edge creation -- replaces manual put + update + rollback logic that could leave orphaned edges
- **Performance:** Per-operation OpenAI timeouts (20-120s by operation type) prevent sequential calls from exhausting Lambda timeout; `_generate_icebreaker` shares `generate_message` timeout via `.get()` fallback
- **Client:** LinkedIn interaction service (2,420 lines, 53 methods) decomposed into 4 domain files (`linkedinMessagingOps`, `linkedinConnectionOps`, `linkedinProfileOps`, `linkedinPostOps`) with thin facade preserving public API
- **Client:** `profileInitService.ts` (1,351 lines) decomposed into 3 domain files (`profileScraping`, `profileBatchProcessing`, `profileIngestion`) with thin orchestrator; shared `MasterIndex` type exported from orchestrator
- **Backend:** Shared Lambda utilities (`get_user_id`, `report_telemetry`, `check_feature_gate`, `lazy_gated_handler`, `sanitize_request_context`, `get_user_edges_cached`) extracted to `shared_services/handler_utils.py`

### Fixed

- **Backend:** `TransactionCanceledException` no longer logs duplicate generic message in outer handler (inner handler already logs with cancellation reasons)
- **Client:** Removed all `(service as any)` type-unsafe casts (23 instances across 3 profile sibling files); `ProfileInitService` fields marked `readonly`
- **Cleanup:** Fixed knip config (added admin workspace entry), removed genuinely unused exports (`RagstackRetryConfig`, `RagstackConfig`, made `loadExistingLinksFromFiles` private)
- **Docs:** Client README route tables replaced with link to `docs/API_REFERENCE.md` (single source of truth)
- **Deps:** `requests` 2.32.5 -> 2.33.0 (CVE-2026-25645), `picomatch` high-severity ReDoS fix
- **CI:** Added `pygments` CVE-2026-4539 ignore in pip-audit (no fix available)

## [1.8.1] - 2026-03-23

### Fixed

- **Security:** WebSocket JWT hardening — explicit `algorithms=['RS256']` (CVE-2025-61152), `client_id` claim validation to prevent cross-application JWT reuse
- **Security:** Module-level env var guard in edge-processing Lambda — `raise RuntimeError` instead of unstructured `KeyError` on missing `DYNAMODB_TABLE_NAME`
- **Performance:** N+1 query in `get_connections_by_status()` replaced with batch fetch — reduces DynamoDB reads from N+1 to 2 calls for connection listings
- **Performance:** BFS path queries use `ProjectionExpression` (7 attrs vs full items) and `max_queue_size=1000` cap to bound traversal
- **Performance:** DynamoDB resource reuse in `batch_get_profile_metadata()` — `boto3.resource` stored in `__init__` instead of recreated per call
- **Performance:** Base64 encoding consolidated into `encode_profile_id()` helper — replaced 13 inline occurrences across 5 files
- **Backend:** Structured exception hierarchy in LLM service — all OpenAI-calling methods now raise `ExternalServiceError(service='OpenAI')` instead of generic `{'success': False}` dicts
- **Backend:** `setup_correlation_context` moved to module-level import in all 9 Lambda handlers (was deferred import in 8 of 9)
- **Backend:** Telemetry failure logging upgraded from `logger.debug` to `logger.warning` in edge-processing
- **Backend:** Ingestion service `_wait_for_indexing` uses `time.monotonic()` for reliable timeout tracking
- **Client:** Extracted `_withAuthenticatedSession` wrapper — eliminates duplicated auth/session/error boilerplate in controller methods
- **Client:** Removed all `fakeReq`/`fakeRes` adapter patterns from 3 controllers (4 instances) — direct service calls instead
- **Client:** Removed stub `generatePersonalizedMessage` endpoint
- **Client:** Seedable PRNG in `BurstThrottleManager` via `randomFn` constructor option
- **Frontend:** Optional Zod schema validation in `httpClient` with `SCHEMA_VALIDATION_ERROR` code
- **Frontend:** MSW `onUnhandledRequest` set to `'error'` — catches unmocked HTTP calls in tests
- **CI:** Admin dashboard added to CI pipeline (lint, typecheck, test)
- **CI:** `pip-audit` added for Python dependency vulnerability scanning
- **CI:** `scripts/setup.sh` uses `uv pip install` instead of bare `pip`
- **Deps:** `werkzeug` 3.1.5 → 3.1.6 (CVE-2026-27199)
- **Cleanup:** Removed debug artifact, unused devDependencies, stale metadata, inline imports, duplicate exports, dead demo data (~900 lines removed)
- **Docs:** Updated all core docs (CLAUDE.md, ARCHITECTURE.md, API_REFERENCE.md, CONFIGURATION.md, README.md) to reflect v1.7–v1.8 additions — 14 drift fixes, 12 gap fills, 7 config drift corrections

## [1.8.0] - 2026-03-22

### Added

- **Admin Dashboard** — Standalone Vite + React SPA (S3 + CloudFront) for cross-user business and operational metrics. Cognito JWT auth gated by `ADMIN_USER_SUB` env var. Desktop-first layout with Recharts visualizations, data tables, and date range picker. Designed as the foundation for a full admin console.
- **Admin Metrics** — User growth (total/paid/free over time), feature adoption heatmap, DAU/WAU, onboarding funnel with per-step drop-off, opportunity pipeline stats, digest delivery and opt-out rates, connection counts per user. Operational metrics from CloudWatch: Lambda invocation counts, error rates, duration, and API Gateway request counts, 4xx/5xx rates, latency.
- **Onboarding Flow** — Hybrid first-login experience with progressive disclosure. LinkedIn credential connection (required, embedded), connection import preview, network graph exploration, and free vs pro tier comparison (pro-only). Hardcoded demo data shows app value before setup. Per-step activity events (`ONBOARDING_STEP_COMPLETED`, `ONBOARDING_COMPLETED`, `ONBOARDING_SKIPPED`) for funnel analytics.
- **Stripe Subscription Management** — End-to-end wiring of existing Stripe components (BillingPage, useCheckout, stripe-webhook, BillingService). New `/billing` subscription management: current plan display, usage statistics, cancel (end-of-billing-period with continued access), and resubscribe.
- **Backend:** `AdminMetricsService` — DynamoDB cross-user aggregation with paginated full-table scan and CloudWatch `GetMetricData` for operational metrics. Cached in `ADMIN#metrics` item with 15-minute TTL.
- **Backend:** `admin-metrics` Lambda with dedicated IAM role (DynamoDB CRUD + CloudWatch read)
- **Backend:** `BillingService._get_customer_for_user()` GSI1 reverse lookup, `get_subscription_details()`, `cancel_subscription()`, `resubscribe()` methods
- **Backend:** `complete_onboarding_step` operation in dynamodb-api with activity event emission
- **Backend:** 5 new `ActivityEventType` members: `ONBOARDING_STEP_COMPLETED`, `ONBOARDING_COMPLETED`, `ONBOARDING_SKIPPED`, `SUBSCRIPTION_CANCELLED`, `SUBSCRIPTION_RESUBSCRIBED`
- **Backend:** `onboarding_completed` and `onboarding_step` user settings fields
- **Frontend:** Full `features/onboarding/` module — `OnboardingContext`, `useOnboarding` hook, `OnboardingOverlay`, 4 step components, static demo data, barrel exports
- **Frontend:** `useSubscription` hook for subscription lifecycle management (React Query)
- **Frontend:** Enhanced `BillingPage` with subscription details, cancel/resubscribe confirmation dialogs, usage stats
- **Admin SPA:** Auth layer (Cognito service, API client, AuthContext, ProtectedRoute, LoginPage)
- **Admin SPA:** Dashboard with 7 visualization components (UserGrowthChart, FeatureAdoptionTable, EngagementChart, OnboardingFunnelChart, ConnectionStatsCard, LambdaHealthTable, ApiGatewayChart)
- **Admin SPA:** MetricCard, DateRangePicker, NavBar, AdminLayout, routing with auth guards
- **Infra:** S3 bucket (public access blocked) + CloudFront distribution with OAC for admin SPA (conditional on `HasAdmin`)
- **Infra:** `AdminMetricsFunction` with `/admin/metrics` API route (conditional on `HasAdmin`)
- **Sync:** Onboarding included in community edition (3 steps, no tier comparison) with dedicated overlays for `OnboardingContext.tsx` and `OnboardingOverlay.tsx`
- **Sync:** Admin dashboard and Stripe billing excluded from community edition (9 new exclude paths)
- **Sync:** `dynamodb-api` overlay updated with `complete_onboarding_step` handler (billing operations excluded)

### Fixed

- **Sync:** Community onboarding overlay auto-completes onboarding when final step is reached (prevents infinite re-trigger on page refresh)

## [1.7.0] - 2026-03-22

### Added

- **Influence Mapping** — Score connections by how many distinct clusters they bridge (company, industry, location, tag). Bridge nodes are surfaced in a new "Influencers" tab on the Network page sidebar. Clicking a node highlights it on the graph.
- **Network Gap Analysis** — Define opportunity targets (companies, roles, industries) and cross-reference against the network graph to identify coverage gaps. New "Gap Analysis" tab on the Network page sidebar with per-opportunity coverage scores and dimension breakdowns.
- **First Contact Icebreakers** — "Break the Ice" button on ConnectionCard for connections with zero message history. Generates contextual icebreaker options using `generate_message` with `mode: "icebreaker"`. Connection notes included as LLM context.
- **Opportunity Tracker** — Goal-oriented relationship pipeline with Kanban board at `/opportunities`. Users create named objectives with structured target criteria and tag connections through 5 fixed stages (identified → reached_out → replied → met → outcome). 10 active opportunity cap with atomic enforcement. Denormalized `opportunities[]` array on edge items for fast renders.
- **Weekly Digest** — AI-generated coaching email aggregating network activity, lifecycle events, and opportunity progress. Delivered via SES (sandbox mode) on Monday schedule using EventBridge fan-out Lambda pattern (coordinator → per-user async). Timezone-aware delivery with auto-detection from frontend.
- **Lifecycle Event Detection** — Profile metadata diff during `profile-init` detects job changes, title updates, location moves. Full field delta stored as `ACTIVITY#` events with 90-day TTL. Integrated fire-and-forget into `_handle_upsert_status`.
- **Backend:** `InfluenceMappingService` — pure computation, bridge score = count of distinct clusters bridged
- **Backend:** `OpportunityService` — full CRUD with atomic 10-cap counter, `transact_write_items` for atomic deletes, paginated edge cleanup
- **Backend:** `GapAnalysisService` — company (exact), role (substring), industry (cluster label) matching with coverage scoring
- **Backend:** `LifecycleEventService` — user-scoped edge metadata diff with tracked field mapping
- **Backend:** `DigestContentService` — weekly activity aggregation with timezone-aware window anchoring
- **Backend:** Digest coordinator Lambda (EventBridge schedule, fan-out pattern) and per-user digest Lambda (SES send, HTML email template)
- **Backend:** 14 new edge-processing handlers with feature gates for all 5 features
- **Backend:** Icebreaker mode in LLM service with dedicated prompt template and multi-icebreaker parsing
- **Backend:** `timezone` and `digest_opted_out` user settings fields with validators
- **Backend:** HMAC-SHA256 unsubscribe token verification (replaces base64)
- **Frontend:** `networkIntelligenceService` with `useInfluenceScores` and `useGapAnalysis` React Query hooks
- **Frontend:** `InfluencersTab` and `GapAnalysisTab` components on `NetworkSidebar` (tabbed interface)
- **Frontend:** Full `features/opportunities/` module — types, service (11 methods), 3 hooks, barrel export
- **Frontend:** `OpportunitiesPage` with `OpportunityKanban`, `StageColumn`, `ConnectionStageCard` (HTML5 drag-and-drop), `CreateOpportunityDialog`
- **Frontend:** `IcebreakerButton` and `IcebreakerDialog` with `useIcebreaker` hook, integrated into `ConnectionCard`
- **Frontend:** `DigestSettings` component with Radix Switch toggle, timezone auto-detection in `UserProfileContext`
- **Frontend:** `OpportunitySummaryCard` on Dashboard with pipeline navigation
- **Frontend:** `/opportunities` route in `App.tsx` with lazy loading
- **Infra:** SES `EmailIdentity` resource (conditional on `HasSESEmail` parameter)
- **Infra:** `DigestCoordinatorFunction` and `DigestPerUserFunction` in SAM template with EventBridge Monday schedule
- **Infra:** `UNSUBSCRIBE_SECRET` from SSM Parameter Store
- **Sync:** 5 new feature flags in `monetization_stubs.py` (all `False` for community edition)
- **Sync:** Feature flags provisioned across `tier_service.py` (free=False) and `billing_service.py` (paid=True)
- **Sync:** 21 new exclude paths in `.sync/config.json` for pro-only files
- **Sync:** New overlays for `ConnectionCard.tsx`, `Profile.tsx`, `Dashboard.tsx`; updated overlays for edge-processing, LLM, App.tsx, monetization.py

### Fixed

- **Frontend:** `updateOpportunity` request body contract — fields now nested under `updates` key matching backend handler expectation
- **Frontend:** Unsafe type casts in `DigestSettings.tsx` replaced with proper `UserProfile` type extension
- **Backend:** `_cleanup_edge_references` in `OpportunityService` now paginates through `LastEvaluatedKey`
- **Backend:** `_query_recent_activities` in `DigestContentService` now paginates through `LastEvaluatedKey`
- **Backend:** `UNSUBSCRIBE_SECRET` env var validated at cold start (raises `RuntimeError` if missing)
- **Backend:** Edge stage methods (`tag_connection_to_opportunity`, `untag_connection_from_opportunity`, `update_connection_stage`) validate profile_id is pre-encoded
- **Backend:** `GapAnalysisService` accepts `opportunityId` key as fallback (avoids DynamoDB SK leakage)
- **Backend:** `_handle_update_opportunity` validates input types before passing to service
- **Backend:** Opportunity delete uses `transact_write_items` for atomic delete + counter decrement

## [1.6.0] - 2026-03-22

### Added

- **Activity Timeline** — Chronological feed of all user actions on the Profile page with category filters (Connections, Messages, AI, Commands) and date range picker. New `ACTIVITY#` DynamoDB record type with 90-day TTL and UUID collision protection. All Lambdas (edge-processing, command-dispatch, dynamodb-api, llm) instrumented to emit activity records.
- **CSV Export** — Client-side CSV export of all connections from the Profile page. Tier-aware: includes relationship scores, cluster memberships, and reply probability for Pro users. RFC 4180 compliant escaping and `\r\n` line endings.
- **Connection Notes** — Private timestamped notes on connections via modal UI on the ConnectionCard. Full CRUD (add, edit, delete) with 1000-character limit per note and atomic 50-note cap via DynamoDB ConditionExpression. Notes fed to LLM during message generation for personalized outreach. UI disclaimer informs users that notes inform AI messages.
- **Backend:** `ActivityService` with paginated queries, date range filtering, and `eventTypes` array support (`IN` filter) for multi-type category filtering
- **Backend:** `write_activity()` fire-and-forget utility with `ActivityEventType` enum (10 event types)
- **Backend:** Note CRUD operations (`add_note`, `update_note`, `delete_note`) on `EdgeDataService` with `notes` array on edge items
- **Backend:** 4 ungated edge-processing handlers for notes and activity timeline
- **Frontend:** `ConnectionNotesModal` with local optimistic state for instant UI updates after mutations
- **Frontend:** `ActivityTimeline` component with `useInfiniteQuery` pagination and server-side category filtering
- **Frontend:** `connectionDataContextService` extended with `prepareConnectionNotes()` for LLM context integration
- **Frontend:** Dedicated `onNotesChanged` prop on `ConnectionCardProps` for clean callback semantics

## [1.5.0] - 2026-03-21

### Added

- **Network Graph Visualization** — Interactive WebGL network graph (`/network`) showing the user's full LinkedIn connection network with force-directed layout (Sigma.js + graphology)
- **Cluster-grouped layout** — ForceAtlas2 layout respects cluster groupings; switching dimensions (company/industry/location/tags) animates node colors in-place without resetting positions
- **Deep-link integration** — "View on graph" buttons on ClusterView and WarmIntroPathsView navigate to `/network?cluster=` or `/network?path=` with highlighted nodes/edges
- **Collapsible sidebar** — Cluster dimension toggle, color legend, search-to-zoom, and ConnectionCard detail panel in a 360px collapsible sidebar
- **Hover tooltips** — Name, position, company, and relationship strength badge on node hover with viewport-edge-aware positioning
- **Path highlighting** — Warm intro paths rendered with gold accent color and dimmed surroundings
- **Backend:** `get_network_graph` bulk endpoint on edge-processing Lambda returning denormalized nodes, edges, and clusters in a single response
- **Backend:** `batch_get_profile_metadata` on EdgeDataService using DynamoDB BatchGetItem (100 keys per call) replacing N+1 GetItem calls
- **Backend:** `network_graph_visualization` feature flag gated on paid tier
- **Frontend:** New `features/network/` module (types, hooks, utils, components) with barrel export
- **Sync:** Community edition excludes network graph feature via `.sync/config.json` and overlay updates

## [1.4.0] - 2026-03-20

### Refactored

- **Backend:** Lambda handlers (`edge-processing`, `llm`, `dynamodb-api`) refactored from if/elif dispatch chains to routing table pattern (`HANDLERS = { 'op': fn }`)
- **Backend:** Feature gate checks consolidated into `_gated_handler()` wrapper in edge-processing
- **Backend:** `LLMService` moved to module-level singleton for warm container reuse
- **Frontend:** `commandService` and `messageGenerationService` migrated from raw `fetch()` to shared `httpClient`

### Fixed

- **Backend:** Stripe error handling stratified: `InvalidRequestError` -> 400, `AuthenticationError` -> 502, generic -> 502
- **Backend:** `os.environ['DYNAMODB_TABLE_NAME']` now fails fast on missing config (was silently defaulting to `'warmreach'` in edge-processing)
- **Backend:** OPTIONS preflight returns 204 No Content in llm Lambda (was 200)
- **Backend:** `time.sleep()` exposure reduced in Lambda retry paths (ingestion polling timeout 60s -> 15s, retry base delays 1.0s -> 0.5s)
- **Backend:** Dead `if table else None` guard removed from dynamodb-api
- **Frontend:** `process.env.NODE_ENV` mock mode check removed from `messageGenerationService` (Vite apps use `import.meta.env`)
- **Frontend:** Error telemetry rate-limited with sliding window (10/min) and hash-based deduplication
- **Frontend:** `generateBatchMessages` now returns `{ results, errors }` so callers can detect partial failures
- **Client:** Synchronous file I/O replaced with `fs/promises` in `fingerprintProfile.ts` and `healingManager.js`
- **Client:** Duplicate `unhandledRejection`/`uncaughtException` handlers removed from `electron-main.js` (server.js handles it)
- **Docs:** 7 drift findings fixed (PRO_FEATURES_ROADMAP, CONFIGURATION.md, DEPLOYMENT.md, DEVELOPMENT.md, CLAUDE.md, ARCHITECTURE.md, .env.example)
- **Docs:** 5 gap findings filled (missing shared services in doc tables, undocumented `get_warm_intro_paths` operation)
- **Docs:** 3 config drift findings fixed (`OPENAI_TIMEOUT`, `DEV_MODE`, `COMMAND_RATE_LIMIT_MAX` documented)
- **Sync:** 6 stale overlay files updated to match routing table refactor

### Added

- **Backend:** `TypedDict` return types: `FeatureFlagResult`, `QuotaStatusResult`, `RateLimitsResult` in `dynamodb_types.py`
- **Frontend:** Typed mock helpers (`buildMockAuthReturn`, `buildMockTierReturn`, `buildMockToastReturn`, `buildMockCommandReturn`) reducing `as any` in tests
- **Frontend:** Unlisted dependencies declared: `next-themes`, `sonner`, `@tailwindcss/typography`, `libsodium-wrappers-sumo`
- **CI:** Backend test coverage enforcement (`--cov-fail-under=75`)
- **CI:** Security scans (Bandit, npm audit) now blocking (removed `continue-on-error`)
- **CI:** Status-check catches cancelled jobs (not just failures)
- **CI:** `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` for GitHub Actions compatibility
- **CI:** `markdownlint-cli2` added to pre-commit pipeline via lint-staged
- **Client:** `unhandledRejection` and `uncaughtException` handlers in Express server

### Removed

- **Client:** Dead code files: `domains/ragstack/index.ts`, `shared/utils/jwksValidator.js`
- **Client:** Dead code in `linkedinInteractionService.js`: unnecessary try/catch in `randomDelay`, dead `checkSuspiciousActivity` branch
- **Client:** Placeholder smoke test (`expect(true).toBe(true)`) replaced with meaningful assertions
- **Frontend:** Unused dependencies: `date-fns`
- **Client:** Unused dependency: `jose`

### Security

- Resolve `flatted` prototype pollution vulnerability (GHSA-rf6f-7fwh-wjgh) via `npm audit fix`

## [1.3.0] - 2026-03-14

### Added

- **Local Profile Scraping** — Puppeteer + cheerio-based local profile scraper with fallback selector cascades and Recent Activity extraction, wired into contact processor with staleness checks
- **Import Mode** — `BackoffController` and `InteractionQueue` gain import modes (10s polling, 4-hour TTL) for bulk operations with human-like burst-pattern throttling
- **Cross-User Ingestion Dedup** — 30-day dedup window prevents redundant RAGStack ingestion across users for the same profile
- **Daily Scrape Cap** — Import checkpoint counter with daily limits and startup state restoration
- **Frontend:** `useSessionStorage` hook mirroring `useLocalStorage` API with `rehydrate()` for external-writer sync
- **Frontend:** `buildLinkedInProfileUrl()` shared utility replacing duplicate implementations across connection cards
- **Backend:** `request_utils.py` shared module (`extract_user_id`, `cors_headers`, `api_response`) eliminating CORS/response boilerplate across 4 Lambda handlers
- **Backend:** `RateLimitUnavailableError` — DynamoDB errors during rate limit checks now return 503 (distinguishable from 429 rate limiting)
- **Backend:** TypedDict definitions for DynamoDB item shapes (`ImportCheckpointItem`, `IngestStateItem`)
- **Backend:** RAGStack document ID stored on edge records
- **Client:** `RateLimiter` class extracted from `linkedinInteractionService.js` to `rateLimiter.ts`
- **Client:** `RagstackProxyService` extracted from `linkedinInteractionService.js` / `profileInitService.ts`
- **Client:** Structured error codes in LinkedIn service layer
- **Client:** Async initialization lock on `BrowserSessionManager`
- **Tests:** LinkedIn service method coverage (searchCompany, applyLocationFilter, analyzeContactActivity, scrollToLoadConnections)
- **Tests:** EdgeDataService rollback path, InsightCacheService error paths, RAGStackProxyService encoding edge cases
- **CI:** Bandit security scanning and npm audit added to CI workflow

### Changed

- **Backend:** EdgeService (933 LOC) decomposed into `EdgeDataService`, `InsightCacheService`, `RAGStackProxyService` in `shared_services/`; original `EdgeService` deprecated as thin facade
- **Backend:** Rate limit and feature flag checks are now fail-closed (deny on error) in `command-dispatch` and `edge-processing`
- **Backend:** OpenAI timeout configurable via `OPENAI_TIMEOUT` env var (default 60s)
- **Backend:** SSM Stripe secret loading uses boto3 adaptive retry (`max_attempts: 2, mode: adaptive`) with 5-minute TTL refresh
- **Backend:** `EdgeDataService` public API uniformly accepts raw `profile_id` and encodes internally
- **Backend:** `is_recently_ingested` promoted to public API on `EdgeDataService`
- **Backend:** CORS handler omits `Access-Control-Allow-Origin` header for requests with no Origin or unrecognized origins
- **Backend:** CORS preflight in `edge-processing` returns 204 (matching `command-dispatch` convention)
- **Backend:** `_get_cached_or_compute` returns consistent `computedAt` timestamp; all timestamps standardized to `.isoformat()`
- **Backend:** LLM Lambda timeout increased to 120s
- **Backend:** EdgeService made module-level singleton for warm container reuse
- **Frontend:** `PostAIAssistant` and `ResearchResultsCard` migrated from direct `sessionStorage` to `useSessionStorage` hook
- **Client:** Puppeteer page event listeners stored as named references and removed individually via `page.off()` in `close()`

### Fixed

- **Backend:** `ragstack_proxy_service.ingest()` now passes b64-encoded `profile_id` to `ingest_profile` (was passing raw URL, producing invalid S3 keys)
- **Backend:** `ragstack_ingest` no longer mutates caller's metadata dict
- **Backend:** `_trigger_ragstack_ingestion` short-circuits before DynamoDB reads when services not injected
- **Backend:** Removed `PROFILE#` prefix guard in `ragstack_proxy_service` (wrong encoding sentinel)
- **Backend:** Removed dead `table` parameter from `compute_and_store_scores`
- **Backend:** Removed unreachable `computedAt` fallback in `get_priority_recommendations`
- **Backend:** Removed duplicated facade methods from `edge_service.py` (canonical implementations in `InsightCacheService`)
- **Frontend:** `useSessionStorage` `setValue` stabilized with ref-based pattern (no recreation on state changes)
- **Frontend:** `useSessionStorage` `initialValue` stabilized via `useRef` (prevents infinite re-render loops with inline objects)
- **Frontend:** Fixed CSS typo `over:` to `hover:` in `ConnectionCard.tsx`
- **Frontend:** Fixed JSON serialization format mismatch between `PostComposerContext` and `useSessionStorage` for shared `ai_research_content` key
- **Client:** `rateLimiter.recordAction()` now prunes stale entries (was growing unbounded)
- **Client:** `ragstackProxyService.ingest()` error handling added (try/catch with `{ success: false }` return)
- **Docs:** Fixed broken link in Phase-3 plan doc
- **Docs:** Redacted real AWS resource IDs from plan docs
- **Docs:** Removed stale RAGStack scrape references from docs and overlays
- **Docs:** Fixed env var documentation in CONFIGURATION.md

### Dependencies

- Bump PyJWT[crypto] from 2.11.0 to 2.12.0
- Add stripe to backend test requirements
- Bump frontend and client production/dev dependencies (multiple Dependabot PRs)
- Add cheerio dependency for local profile scraping

## [1.2.3] - 2026-03-06

### Added

- **Test Infrastructure:** Shared test factory modules for frontend (`test-utils/factories.ts`, `test-utils/mocks.ts`) and client (`test-utils/factories.ts`, `test-utils/mocks.ts`) with typed builder functions for all domain entities
- **Test Infrastructure:** MSW (Mock Service Worker) integration for frontend integration tests — intercepts HTTP at the network level instead of mocking axios
- **Test Infrastructure:** `createAuthenticatedWrapper()` composing QueryClient + AuthContext for hook integration testing
- **Frontend Tests:** 14 new unit test files for previously untested services, hooks, and contexts (httpClient, WebSocketContext, TierContext, API services, etc.)
- **Frontend Tests:** 5 integration tests exercising hook-to-service-to-HTTP flows via MSW (useProfileSearch, useConnections, useMessageHistory, useLinkedInSearch, useProgressTracker)
- **Client Tests:** 9 new unit test files for untested domain services (linkedinConnectionService, browserSessionManager, healAndRestoreService, etc.)
- **Client Tests:** 9 new unit test files for untested domain utilities (contactProcessor, searchRequestValidator, selectorRegistry, etc.)
- **Backend Tests:** 3 new integration tests (command dispatch, quota exhaustion lifecycle, WebSocket connect/disconnect lifecycle)
- **Backend Tests:** Boundary condition tests for quota service and RAGStack client (at-limit, zero-value, negative count, empty queries)
- **E2E Tests:** 4 new Playwright specs (auth-errors, search-workflow, messaging-workflow, workflow-recovery)
- **Repo:** `.github/CODEOWNERS` for critical path review enforcement
- **Repo:** `.github/pull_request_template.md` standardizing PR descriptions
- **Docs:** `CONTRIBUTING.md` with workflow, testing, commit, and code style guidance
- **Docs:** Mermaid architecture diagram in `ARCHITECTURE.md`
- **Docs:** cURL request/response examples for all endpoints in `API_REFERENCE.md`

### Changed

- **Frontend:** Coverage thresholds raised (lines 37% to 78%, branches 71% to 67%, functions 54% to 73%, statements 37% to 76%)
- **Client:** Coverage thresholds raised (lines 18% to 50%, branches 17% to 45%, functions 24% to 50%, statements 18% to 50%)
- **Commitlint:** Added `body-empty` warning rule and `security` to `type-enum`
- **README:** Added project context paragraph for first-time visitors

### Refactored

- **Frontend:** Brittle tests in ragstackSearchService and commandService converted from request-shape assertions to behavior-focused assertions
- **Client:** Brittle tests in jwtValidator and linkedinContactService converted from exact error-string matching to category/partial matching
- **Frontend/Client:** Inline mock objects replaced with factory builder calls across modified test files

### Fixed

- **Frontend:** `isProgressState` type guard now checks `phase` field instead of nonexistent `status`
- **Frontend:** Stale closure in `useLinkedInSearch` — removed `error` from dependency array, `fetchConnections()` called unconditionally
- **Frontend:** Parameter mutation in `errorHandling.ts` — `signInAction` extracted to typed const
- **Client:** Deprecated `substr` replaced with `slice` in `profileInitController`

### Dependencies

- Bump frontend production dependencies: React 18 to 19, react-router-dom 6 to 7, date-fns 3 to 4, recharts 2 to 3, tailwind-merge 2 to 3, zod 3 to 4, lucide-react, @tanstack/react-virtual

## [1.2.2] - 2026-03-05

### Refactored

- **Backend:** Implemented distributed circuit breaker using DynamoDB for shared state management across Lambda instances.
- **Backend:** Migrated correlation ID tracking to `contextvars` for thread-safe, execution-scoped logging.
- **Backend:** Optimized cold starts with lazy initialization for DynamoDB and Stripe SDKs.
- **Frontend:** Re-introduced Branded Types for nominal ID safety across domain entities.
- **Frontend:** Standardized `HttpClient` and all service layers to use the `ApiResult` discriminated union for mandatory error handling.
- **General:** Extensive cleanup of dead code, internalized module-private types, and consolidated client-side configuration.

## [1.2.1] - 2026-03-04

### Security

- Replace `python-jose` with `PyJWT` in websocket-connect Lambda to fix CVE-2025-61152 (`alg=none` signature bypass)
- Remove hardcoded API Gateway URL fallbacks in frontend config and command service
- Scope Bedrock IAM policy from `foundation-model/*` to `foundation-model/${BedrockModelId}`

### Added

- DeletionPolicy: Retain and PITR for DynamoDB tables and Cognito user pool
- API Gateway throttling (burst: 50, rate: 25 req/s)
- 8 CloudWatch alarms (Lambda errors, DynamoDB throttles, API 4xx/5xx, WebSocket errors, Stripe webhook failures) with SNS notification
- Credential rotation runbook (`docs/plans/v1.2.1/CREDENTIAL-ROTATION.md`)
- `--connect` mode for `linkedin-inspect.mjs` (attach to existing Chrome via remote debugging)

### Fixed

- Resolve npm audit vulnerabilities in client and frontend
- Remove unused `puppeteer-extra` dependency from linkedin-inspect

### Dependencies

- Bump actions/checkout from 4 to 6
- Bump client dev dependencies (6 updates)
- Bump client production dependencies (axios, ioredis, puppeteer)
- Bump frontend production dependencies (react-virtual, axios, react-router-dom, lucide-react)

## [1.2.0] - 2026-02-26

### Added

- **Resilient Selector Engine** — Multi-strategy cascade (aria → data-attr → text → CSS) with centralized per-domain selector registries; all LinkedIn services migrated off hardcoded class selectors
- **Persistent Fingerprint Profiles** — Deterministic canvas, WebGL, audio, and UA fingerprints persisted to disk and rotated monthly via seeded PRNG, eliminating per-session inconsistency as a detection signal
- **Adaptive Backoff System** — `SignalDetector` aggregates response timing, HTTP status codes, page content signals, and session metrics into a weighted threat level; `BackoffController` pauses the interaction queue and fires a tray notification when threshold is crossed
- **Checkpoint / CAPTCHA Detection** — URL and content pattern matching pauses automation immediately and surfaces a native Electron tray notification requiring manual resolution

### Changed

- `InteractionQueue` gains `pause(reason)`, `resume()`, `isPaused()`, and `getPauseStatus()` methods used by the backoff system
- `stealthScripts` canvas, WebGL, and audio noise functions now accept a seed parameter for deterministic replay across page loads within a session
- `BrowserSessionManager` initializes and owns `SignalDetector`, `SessionMetrics`, `ContentSignalAnalyzer`, and `BackoffController` per session
- Electron tray menu reflects live automation pause/resume state and threat level, updating every 10 seconds

## [1.1.1] - 2026-02-22

### Added

- Auto-release workflow — creating a release from CHANGELOG.md changes on push to main
- Commitlint enforcement via Husky `commit-msg` hook
- Lambda overlays for edge-processing and LLM lambdas to strip Pro logic from community sync

### Fixed

- Remove stale `tone_analysis_service.py` overlay mapping to nonexistent file
- Fix race condition in release workflow (remove tag trigger that caused duplicate runs)
- Fix community CI failures — create `test_edge_service.py` overlay (strip Pro tests) and remove test files from sync `exclude_paths` so overlays are applied instead of deleted
- Add "Active Development" notice to community README overlay

## [1.1.0] - 2026-02-22

### Added

- **[Pro]** Tone Analysis — LLM-powered tone evaluation (professionalism, warmth, clarity, sales pressure) for draft LinkedIn messages
- **[Pro]** Best Time to Send — Analyze message history to recommend optimal send times per connection based on response patterns
- **[Pro]** Reply Probability — Predict response likelihood for each connection using recency, frequency, reciprocity, and message length signals
- **[Pro]** Priority Inference — Rank connections by outreach priority combining reply probability, recency decay, relationship strength, and engagement signals with DynamoDB caching
- **[Pro]** Cluster Detection — Group connections by shared company, industry, location, or tags to reveal network patterns
- Shared `compute_response_rate` utility extracted to `message_utils.py` to deduplicate logic across services
- Lambda overlay infrastructure for edge-processing and LLM lambdas to strip Pro operations from community sync
- Release workflow (`release.yml`) to create GitHub Releases from tag pushes using CHANGELOG.md
- Commitlint enforcement via Husky `commit-msg` hook

### Changed

- Extract `_check_feature_gate` helper in edge-processing lambda, replacing 11 identical 6-line blocks with 2-line calls
- Add DynamoDB caching (7-day TTL) for priority recommendations following the messaging insights pattern
- Inject `PriorityInferenceService` and `ReplyProbabilityService` into EdgeService constructor for warm container reuse

### Fixed

- Fix substring matching bug in `ClusterDetectionService` — use exact equality for company/industry/location grouping
- Fix hardcoded confidence value in `ReplyProbabilityService` — derive from signal count
- Fix ClusterView wording: "clusters found" to "groups found", "unclustered" to "ungrouped"
- Fix stale `tone_analysis_service.py` overlay mapping to nonexistent file
- Fix broken plan doc links in `PRO_FEATURES_ROADMAP.md` (old Phase paths to correct v1.0/v1.1 paths)

## [1.0.0] - 2026-02-22

First versioned release of WarmReach.

### Added

- **Relationship Strength Scoring** (Pro) — Score connections 0-100 based on frequency, recency, reciprocity, profile completeness, and conversation depth. Scores computed on login and displayed as badges on connection cards.
- **Message Intelligence** (Pro) — Analyze messaging patterns across all connections. Compute response rates, timing, volume, and conversation depth. LLM-powered insights from sample outbound messages.
- **Advanced Analytics Dashboard** (Pro) — Connection funnel visualization, network growth timeline, engagement metrics, and usage summary with configurable time periods.
- Anti-fingerprinting mitigations for Puppeteer browser automation
- Community edition sync infrastructure (overlays, exclusions, automated sync on push)
- Pro features roadmap documentation
- CI workflows for tests, linting, Electron releases, and public repo sync

### Fixed

- Paginate all DynamoDB edge queries (`get_connections_by_status`, `compute_and_store_scores`, `get_messaging_insights`) to handle users with >1000 connections
- Correct funnel conversion rates to use stage-to-stage denominators instead of total count
- Thread `days` parameter from frontend through `get_dashboard_summary` to all sub-queries
- Collect cross-connection sample messages for LLM analysis instead of biased single-connection sampling
- Fetch edges once in `get_dashboard_summary` instead of 3 redundant full scans
- Use DynamoDB key condition for usage date filtering instead of Python-side filtering
- Guard `store_message_insights` with `ConditionExpression` to prevent orphaned items
- Fix `refreshStats` double-fetch with single `queryClient.fetchQuery` call
- Add 2s delay before score invalidation to avoid DynamoDB write race
- Validate `days` parameter as numeric, return 400 on invalid input
- Handle empty `first_name` in connection card avatar fallback
- Exclude pro frontend components from community edition sync
- Fix CognitoUserPool mock constructor in test files (arrow functions not constructable)
- Pin eslint ecosystem to v9-compatible versions to resolve peer dependency conflicts
- Add stub overlays for pro backend services imported by shared code
- Release-triggered sync workflow to mirror releases to community repo

### Dependencies

- Bump actions/setup-node from 4 to 6
- Bump actions/setup-python from 5 to 6
- Bump electron-builder from 26.7.0 to 26.8.1
- Bump production dependencies in frontend and client
- Merge dependabot PRs for frontend and client dependencies
