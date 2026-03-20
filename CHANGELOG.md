# Changelog

All notable changes to WarmReach will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
