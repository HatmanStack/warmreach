# Changelog

All notable changes to WarmReach will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
