# Changelog

All notable changes to WarmReach will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
