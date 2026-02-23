# Changelog

All notable changes to WarmReach will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
