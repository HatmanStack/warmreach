"""LLMService - Business logic for LLM operations."""

import json
import logging
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

# Shared layer imports (from /opt/python via Lambda Layer)
import openai
from shared_services.base_service import BaseService

# Retry configuration + wrapper for transient OpenAI errors. The canonical
# implementation lives in the shared layer so it is reused everywhere; re-exported
# at module level (MAX_RETRIES / RETRY_BACKOFF_BASE_S / _retry_openai_call) for
# parity with the pro edition.
from shared_services.openai_retry import (  # noqa: F401 — re-exported for parity
    MAX_RETRIES,
    RETRY_BACKOFF_BASE_S,
    retry_openai_call as _retry_openai_call,
)

try:
    from prompts import (
        ANALYZE_MESSAGE_PATTERNS_PROMPT,
        ANALYZE_TONE_PROMPT,
        GENERATE_ICEBREAKER_PROMPT,
        GENERATE_MESSAGE_PROMPT,
        LINKEDIN_IDEAS_PROMPT,
        LINKEDIN_RESEARCH_PROMPT,
        SYNTHESIZE_RESEARCH_PROMPT,
    )
except ImportError:
    LINKEDIN_IDEAS_PROMPT = '{user_data}\n{raw_ideas}'
    LINKEDIN_RESEARCH_PROMPT = '{topics}\n{user_data}'
    SYNTHESIZE_RESEARCH_PROMPT = '{user_data}\n{research_content}\n{post_content}\n{ideas_content}'
    GENERATE_MESSAGE_PROMPT = '{sender_data}\n{recipient_name}\n{recipient_position}\n{recipient_company}\n{recipient_headline}\n{recipient_tags}\n{recipient_context}\n{conversation_topic}\n{message_history}'
    GENERATE_ICEBREAKER_PROMPT = '{sender_data}\n{recipient_name}\n{recipient_position}\n{recipient_company}\n{recipient_headline}\n{recipient_tags}\n{recipient_context}\n{connection_notes}'
    ANALYZE_MESSAGE_PATTERNS_PROMPT = (
        '{total_outbound}\n{total_inbound}\n{response_rate}\n{avg_response_time}\n{sample_messages}'
    )
    ANALYZE_TONE_PROMPT = '{draft_text}\n{recipient_name}\n{recipient_position}\n{relationship_status}'

logger = logging.getLogger(__name__)

# Placeholder name used for demo/test profiles that should be skipped
PROFILE_PLACEHOLDER_NAME = 'Tom, Dick, And Harry'

# Per-operation timeout overrides (seconds) for OpenAI responses.create() calls.
# Default client timeout (60s) is used as fallback via .get(name, 60).
#
# Timeout budget: Lambda timeout is 120s. Every OpenAI timeout must leave at
# least 30s of margin for SSM parameter fetch, DynamoDB operations, quota
# checks, and response serialization. Max allowed value = 120 - 30 = 90s.
OPERATION_TIMEOUTS: dict[str, int] = {
    'generate_ideas': 30,
    'generate_message': 25,
    'analyze_tone': 20,
    'analyze_message_patterns': 30,
    'research_selected_ideas': 90,
    'synthesize_research': 60,
}

# A deep-research job still 'in_progress' this long after kickoff is a zombie
# (o4-mini deep research finishes well within an hour). Past this cutoff
# get_active_research won't auto-resume it (so it can't inject stale content into
# the composer on the user's next visit) and the reconciler retires it.
STALE_RESEARCH_HOURS = 6


def parse_iso_datetime(value):
    """Parse a stored ISO timestamp string; return None if missing/unparseable.

    Always returns a timezone-aware datetime (assumes UTC when the stored value
    carries no offset) so callers can compare it against an aware cutoff without
    a TypeError — a naive value slipping through would otherwise abort the whole
    reconciliation pass.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


class LLMService(BaseService):
    """
    Service class for LLM-powered content generation operations.

    Handles idea generation, research, synthesis, and style transformations
    using OpenAI with injected clients for testability.
    """

    def __init__(self, openai_client, table=None):
        """
        Initialize LLMService with injected dependencies.

        Args:
            openai_client: OpenAI client for GPT operations
            table: DynamoDB Table resource for result storage (optional)
        """
        super().__init__()
        self.openai_client = openai_client
        self.table = table

    def _persist_profile_field(self, user_id: str | None, field: str, value) -> None:
        """Upsert (or REMOVE) a single field on the user's #SETTINGS profile item.

        Pass ``value=None`` to clear the attribute. Failures are logged but
        never raised — profile persistence must not break the LLM response
        path.
        """
        if not self.table or not user_id:
            return
        try:
            ts = datetime.now(UTC).isoformat()
            key = {'PK': f'USER#{user_id}', 'SK': '#SETTINGS'}
            if value is None:
                self.table.update_item(
                    Key=key,
                    UpdateExpression=('SET updated_at = :ts, created_at = if_not_exists(created_at, :ts) REMOVE #f'),
                    ExpressionAttributeNames={'#f': field},
                    ExpressionAttributeValues={':ts': ts},
                )
            else:
                self.table.update_item(
                    Key=key,
                    UpdateExpression=('SET #f = :v, updated_at = :ts, created_at = if_not_exists(created_at, :ts)'),
                    ExpressionAttributeNames={'#f': field},
                    ExpressionAttributeValues={':v': value, ':ts': ts},
                )
        except Exception as e:
            # Lazy %-style — avoids string construction when the log
            # level is suppressed and matches the pro version.
            logger.warning('Failed to persist profile field %s for user %s: %s', field, user_id, e)

    def _set_research_status(self, user_id: str | None, job_id: str, status: str) -> None:
        """Best-effort status flip on a RESEARCH# row. Never raises.

        Used to mark a job 'failed' when kickoff dies, 'cancelled' on user
        cancel, and 'abandoned' by the reconciler for stale zombies.
        """
        if not self.table or not user_id:
            return
        try:
            self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': f'RESEARCH#{job_id}'},
                UpdateExpression='SET #s = :s, updated_at = :ts',
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={':s': status, ':ts': datetime.now(UTC).isoformat()},
            )
        except Exception as e:
            logger.warning('Failed to set research status %s for job %s: %s', status, job_id, e)

    def _abandon_other_active_research(self, user_id: str, keep_job_id: str) -> None:
        """Mark the user's OTHER active RESEARCH# rows 'abandoned'.

        Starting a new research supersedes any prior in-flight one; abandoning
        them at kickoff (rather than relying on the 5-minute reconciler) stops an
        older still-running job from being resumed/reconciled and clobbering the
        new one's result. Best-effort; never raises.
        """
        if not self.table:
            return
        try:
            resp = self.table.query(
                KeyConditionExpression='PK = :pk AND begins_with(SK, :sk)',
                ExpressionAttributeValues={':pk': f'USER#{user_id}', ':sk': 'RESEARCH#'},
                ProjectionExpression='SK, #s',
                ExpressionAttributeNames={'#s': 'status'},
            )
            for it in resp.get('Items', []):
                if it.get('status') not in ('starting', 'in_progress'):
                    continue
                other_job_id = it['SK'].split('#', 1)[1]
                if other_job_id != keep_job_id:
                    self._set_research_status(user_id, other_job_id, 'abandoned')
        except Exception as e:
            logger.warning(f'Could not supersede prior research for {user_id}: {e}')

    def _attach_research_response_id(self, user_id: str, job_id: str, response_id: str) -> None:
        """Persist openai_response_id + flip to in_progress after a successful kickoff.

        The OpenAI background job is already running by the time this runs, so a
        transient DynamoDB failure here must NOT propagate (that would 500 the
        request and make the user re-run). boto3 retries transient errors
        internally; on a hard failure we log loudly and leave the discoverable
        'starting' row for a later get_active_research / reconciler to recover.
        """
        if not self.table:
            return
        try:
            self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': f'RESEARCH#{job_id}'},
                UpdateExpression='SET openai_response_id = :rid, #s = :s',
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={':rid': response_id, ':s': 'in_progress'},
            )
        except Exception as e:
            logger.error(
                f'CRITICAL: could not persist openai_response_id {response_id} for research '
                f'job {job_id} (user {user_id}): {e}; the OpenAI job is running but the row '
                f'stays "starting" until recovered'
            )

    def generate_ideas(self, user_profile: dict, prompt: str, job_id: str, user_id: str) -> dict[str, Any]:
        """
        Generate LinkedIn content ideas using AI.

        Args:
            user_profile: User profile data for context
            prompt: User's prompt/topic ideas
            job_id: Job ID for tracking
            user_id: User ID for metadata

        Returns:
            dict with success status and queued status
        """
        try:
            # Clear stale profile-level ideas at handler entry so the UI never
            # shows an old result while a new generation is in flight.
            self._persist_profile_field(user_id, 'ai_generated_ideas', None)

            user_data = ''
            if user_profile and user_profile.get('name') != PROFILE_PLACEHOLDER_NAME:
                user_data = self._format_user_profile_context(user_profile)

            llm_prompt = LINKEDIN_IDEAS_PROMPT.format(
                user_data=user_data, raw_ideas=self._sanitize_prompt(prompt or '')
            )

            response = self.openai_client.responses.create(
                model='gpt-5.2',
                input=llm_prompt,
                timeout=OPERATION_TIMEOUTS.get('generate_ideas', 60),
            )

            # Parse ideas from response
            has_output_text = hasattr(response, 'output_text')
            content = response.output_text if has_output_text else str(response)
            logger.info(f'generate_ideas response: has_output_text={has_output_text}, content_length={len(content)}')
            ideas = self._parse_ideas(content)
            logger.info(f'generate_ideas parsed {len(ideas)} ideas')

            # Store in DynamoDB for future reference (24h TTL)
            if self.table and ideas:
                self.table.put_item(
                    Item={
                        'PK': f'USER#{user_id}',
                        'SK': f'IDEAS#{job_id}',
                        'ideas': ideas,
                        'created_at': datetime.now(UTC).isoformat(),
                        'ttl': int((datetime.now(UTC) + timedelta(hours=24)).timestamp()),
                    }
                )

            if ideas:
                self._persist_profile_field(user_id, 'ai_generated_ideas', ideas)

            return {'success': True, 'ideas': ideas}

        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in generate_ideas: {e}')
            return {'success': False, 'error': 'Failed to generate ideas'}
        except Exception as e:
            logger.error(f'Error in generate_ideas: {e}')
            return {'success': False, 'error': 'Failed to generate ideas'}

    def _parse_ideas(self, content: str) -> list[str]:
        """Parse ideas from LLM response text."""

        if not content:
            return []
        if 'Idea:' in content:
            parts = content.split('Idea:')
            return [part.strip() for part in parts[1:] if part.strip()]
        # Fallback: strip numbered-list prefixes (e.g., "1. ", "2) ", "3- ")
        lines = [re.sub(r'^\s*\d+[\.\)\-]?\s*', '', line) for line in content.strip().split('\n') if line.strip()]
        return [line for line in lines if line]

    def research_selected_ideas(self, user_data: dict, selected_ideas: list, user_id: str) -> dict[str, Any]:
        """
        Research selected ideas using AI with web search.

        Args:
            user_data: User profile data
            selected_ideas: List of ideas to research
            user_id: User ID

        Returns:
            dict with success status and job_id
        """
        if not selected_ideas:
            return {'success': False, 'error': 'No ideas selected for research'}

        # Clear stale profile-level research at handler entry. Deep research
        # polling can take 5-30 minutes; the UI must not display the previous
        # result while the new job runs.
        self._persist_profile_field(user_id, 'ai_generated_research', None)

        job_id = str(uuid.uuid4())

        # Persist a discoverable RESEARCH# row BEFORE the OpenAI call returns so a
        # refresh during kickoff can't lose the job (status='starting', no
        # response_id yet). selected_ideas power the "which topic" indicator and
        # give the reconciler context.
        now = datetime.now(UTC)
        if self.table:
            self.table.put_item(
                Item={
                    'PK': f'USER#{user_id}',
                    'SK': f'RESEARCH#{job_id}',
                    'status': 'starting',
                    'selected_ideas': [str(idea)[:500] for idea in selected_ideas],
                    'created_at': now.isoformat(),
                    'ttl': int((now + timedelta(days=7)).timestamp()),
                }
            )

        # Supersede any prior in-flight research so a still-running older job
        # can't later be resumed/reconciled and clobber this one.
        self._abandon_other_active_research(user_id, job_id)

        formatted_user_data = ''
        if user_data and user_data.get('name') != PROFILE_PLACEHOLDER_NAME:
            formatted_user_data = self._format_user_profile_context(user_data)

        formatted_topics = '\n'.join([f'- {self._sanitize_prompt(idea, 500)}' for idea in selected_ideas])

        research_prompt = LINKEDIN_RESEARCH_PROMPT.format(topics=formatted_topics, user_data=formatted_user_data)

        try:
            response = self.openai_client.responses.create(
                model='o4-mini-deep-research',
                input=research_prompt,
                timeout=OPERATION_TIMEOUTS.get('research_selected_ideas', 60),
                background=True,
                metadata={'job_id': job_id, 'user_id': user_id, 'kind': 'RESEARCH'},
                tools=[
                    {'type': 'web_search_preview'},
                    {'type': 'code_interpreter', 'container': {'type': 'auto'}},
                ],
            )
        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in research_selected_ideas: {e}')
            self._set_research_status(user_id, job_id, 'failed')
            return {'success': False, 'error': 'Failed to research selected ideas'}
        except Exception as e:
            logger.error(f'Error in research_selected_ideas: {e}')
            self._set_research_status(user_id, job_id, 'failed')
            return {'success': False, 'error': 'Failed to research selected ideas'}

        # Attach the OpenAI response_id and flip to in_progress. This is
        # failure-tolerant (the job is already running) — see the helper.
        self._attach_research_response_id(user_id, job_id, response.id)

        return {
            'success': True,
            'job_id': job_id,
        }

    def get_research_result(self, user_id: str, job_id: str, kind: str | None = None) -> dict[str, Any]:
        """
        Get research result from DynamoDB.

        Args:
            user_id: User ID
            job_id: Job ID to look up
            kind: Result kind (IDEAS, RESEARCH, SYNTHESIZE)

        Returns:
            dict with success status and content if found
        """
        try:
            if not self.table:
                logger.error('DynamoDB table not configured')
                return {'success': False}

            prefixes = []
            if kind == 'IDEAS':
                prefixes = ['IDEAS']
            elif kind == 'RESEARCH':
                prefixes = ['RESEARCH']
            elif kind == 'SYNTHESIZE':
                prefixes = ['SYNTHESIZE']
            else:
                prefixes = ['IDEAS', 'RESEARCH', 'SYNTHESIZE']

            item = None
            found_kind = None

            for prefix in prefixes:
                response = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': f'{prefix}#{job_id}'})
                item = response.get('Item')
                if item:
                    found_kind = prefix
                    break

            if not item:
                return {'success': False}

            # If item has an openai_response_id but no content, poll OpenAI directly
            openai_response_id = item.get('openai_response_id')
            if openai_response_id and item.get('status') == 'in_progress':
                return self._check_openai_response(user_id, job_id, openai_response_id, found_kind)

            # Return appropriate response
            if item.get('ideas'):
                return {'success': True, 'ideas': item.get('ideas')}
            if item.get('content'):
                return {'success': True, 'content': item.get('content')}
            return {'success': False}

        except Exception as e:
            logger.error(f'Error in get_research_result: {e}')
            return {'success': False}

    def _check_openai_response(self, user_id: str, job_id: str, response_id: str, kind: str) -> dict[str, Any]:
        """Check OpenAI response status and store result if complete.

        OpenAI's terminal non-completed states (failed/cancelled/expired/
        incomplete) and a completed-but-empty response are mapped to a terminal
        row status so the frontend poll and the reconciler stop working a job
        that is already resolved. Only RESEARCH# rows reach this path.
        """
        try:
            resp = self.openai_client.responses.retrieve(response_id)
            status = getattr(resp, 'status', None)
            logger.info(f'OpenAI response status for {response_id}: {status}')

            if status in ('failed', 'cancelled', 'expired', 'incomplete'):
                terminal = 'cancelled' if status == 'cancelled' else 'failed'
                self._set_research_status(user_id, job_id, terminal)
                return {'success': False, 'status': terminal, 'terminal': True}

            if status != 'completed':
                return {'success': False, 'status': status or 'pending'}

            content = self._extract_response_content(resp)

            if not content or not content.strip():
                logger.error(f'OpenAI response {response_id} completed but returned empty content')
                # Terminal: don't let pollers/reconciler re-check a dead job.
                self._set_research_status(user_id, job_id, 'failed')
                return {
                    'success': False,
                    'status': 'failed',
                    'terminal': True,
                    'error': 'OpenAI returned empty content',
                }

            content = content.strip()

            # Update DynamoDB with the completed result
            if self.table:
                self.table.update_item(
                    Key={'PK': f'USER#{user_id}', 'SK': f'{kind}#{job_id}'},
                    UpdateExpression='SET content = :c, #s = :s',
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={':c': content, ':s': 'completed'},
                )

            if kind == 'RESEARCH':
                self._persist_profile_field(user_id, 'ai_generated_research', content)

            return {'success': True, 'content': content}

        except Exception as e:
            logger.error(f'Error checking OpenAI response: {e}')
            return {'success': False}

    def get_active_research(self, user_id: str) -> dict[str, Any]:
        """Find the user's most recent active deep-research job and reconcile it.

        Returns the newest RESEARCH# row whose status is 'starting' or
        'in_progress'. When it carries an openai_response_id, poll OpenAI (via
        _check_openai_response) so a job OpenAI already finished is persisted +
        mirrored to the profile even though no browser was polling. Used by
        resume-on-load after a refresh, when the client no longer holds the
        job_id.
        """
        if not self.table:
            return {'success': True, 'active': False}
        try:
            # Project only the fields we need and paginate: RESEARCH# rows can each
            # hold multiple KB of completed `content`, so without a projection the
            # 1MB page could fill before the newest active row (keyed by random
            # uuid) is seen, and get_active_research would wrongly report inactive.
            items = []
            query_kwargs = {
                'KeyConditionExpression': 'PK = :pk AND begins_with(SK, :sk)',
                'ExpressionAttributeValues': {':pk': f'USER#{user_id}', ':sk': 'RESEARCH#'},
                'ProjectionExpression': 'SK, #s, created_at, openai_response_id, selected_ideas',
                'ExpressionAttributeNames': {'#s': 'status'},
            }
            while True:
                resp = self.table.query(**query_kwargs)
                items.extend(resp.get('Items', []))
                last = resp.get('LastEvaluatedKey')
                if not last:
                    break
                query_kwargs['ExclusiveStartKey'] = last
        except Exception as e:
            logger.error(f'get_active_research query failed for {user_id}: {e}')
            return {'success': False}

        active = [i for i in items if i.get('status') in ('starting', 'in_progress')]
        # Ignore stale zombies: a job still active many hours after kickoff won't
        # be auto-resumed. Otherwise a long-abandoned job (still in_progress here
        # but completed on OpenAI) could clobber the profile's current research on
        # the user's next visit. The reconciler retires these separately. A row
        # with no/unparseable created_at is kept (fail-open) rather than dropped.
        cutoff = datetime.now(UTC) - timedelta(hours=STALE_RESEARCH_HOURS)
        fresh = []
        for i in active:
            created = parse_iso_datetime(i.get('created_at'))
            if created is None or created >= cutoff:
                fresh.append(i)
        active = fresh
        if not active:
            return {'success': True, 'active': False}

        newest = max(active, key=lambda i: i.get('created_at', ''))
        job_id = newest['SK'].split('#', 1)[1]
        selected_ideas = newest.get('selected_ideas', [])
        response_id = newest.get('openai_response_id')

        # No response_id yet: kickoff is still creating the OpenAI job. Report it
        # as active/starting so the UI shows the indicator and keeps polling.
        if not response_id:
            return {
                'success': True,
                'active': True,
                'status': 'starting',
                'job_id': job_id,
                'selected_ideas': selected_ideas,
            }

        result = self._check_openai_response(user_id, job_id, response_id, 'RESEARCH')
        if result.get('success') and result.get('content'):
            return {
                'success': True,
                'active': False,
                'status': 'completed',
                'job_id': job_id,
                'selected_ideas': selected_ideas,
                'content': result['content'],
            }
        if result.get('terminal'):
            # OpenAI reported a terminal failure/cancel (now recorded on the row).
            # Stop showing the indicator instead of spinning until the 6h cutoff.
            return {
                'success': True,
                'active': False,
                'status': result.get('status', 'failed'),
                'job_id': job_id,
                'selected_ideas': selected_ideas,
            }
        # Still running on OpenAI (or a transient poll miss) — keep the indicator.
        return {
            'success': True,
            'active': True,
            'status': result.get('status', 'in_progress'),
            'job_id': job_id,
            'selected_ideas': selected_ideas,
        }

    def cancel_research(self, user_id: str, job_id: str) -> dict[str, Any]:
        """Cancel an in-progress deep-research job.

        Best-effort cancels the OpenAI background response (only background
        responses are cancellable) and flips the RESEARCH# row to 'cancelled' so
        pollers and the reconciler stop touching it.
        """
        if not self.table:
            return {'success': False, 'error': 'Storage not configured'}
        try:
            resp = self.table.get_item(Key={'PK': f'USER#{user_id}', 'SK': f'RESEARCH#{job_id}'})
            item = resp.get('Item')
        except Exception as e:
            logger.error(f'cancel_research lookup failed for {user_id}/{job_id}: {e}')
            return {'success': False}
        if not item:
            return {'success': False, 'error': 'Research job not found'}

        # If the job already finished (completed just as the cancel landed),
        # there's nothing to cancel — leave the 'completed' status + content
        # intact rather than mislabeling a finished job 'cancelled'.
        if item.get('content') or item.get('status') == 'completed':
            return {'success': True, 'already_completed': True}

        response_id = item.get('openai_response_id')
        if response_id:
            try:
                self.openai_client.responses.cancel(response_id)
            except Exception as e:
                # The job may already be completed/failed on OpenAI, in which case
                # cancel 404s/409s. Not fatal — we still mark our row cancelled.
                logger.info(f'OpenAI cancel for {response_id} was a no-op or failed: {e}')

        # Flip the row to 'cancelled'. Unlike the best-effort _set_research_status,
        # surface a failure here: if this write is lost the OpenAI job may still
        # complete and the reconciler would mirror it back in, so the client must
        # learn the cancel didn't land and can retry.
        try:
            self.table.update_item(
                Key={'PK': f'USER#{user_id}', 'SK': f'RESEARCH#{job_id}'},
                UpdateExpression='SET #s = :s, updated_at = :ts',
                ExpressionAttributeNames={'#s': 'status'},
                ExpressionAttributeValues={':s': 'cancelled', ':ts': datetime.now(UTC).isoformat()},
            )
        except Exception as e:
            logger.error(f'cancel_research could not record cancellation for {user_id}/{job_id}: {e}')
            return {'success': False, 'error': 'Failed to record cancellation'}
        return {'success': True}

    def _extract_response_content(self, response) -> str:
        """Extract text content from an OpenAI response, handling multiple output formats."""
        # Try output_text first (standard responses)
        if hasattr(response, 'output_text') and response.output_text:
            logger.info(f'Extracted content from output_text, length={len(response.output_text)}')
            return response.output_text

        # Fallback: extract text from output array (deep research responses)
        if hasattr(response, 'output') and response.output:
            text_parts = []
            for item in response.output:
                if hasattr(item, 'type') and item.type == 'message':
                    if hasattr(item, 'content') and item.content:
                        for content_item in item.content:
                            if hasattr(content_item, 'text'):
                                text_parts.append(content_item.text)
                elif hasattr(item, 'text'):
                    text_parts.append(item.text)
            if text_parts:
                content = '\n'.join(text_parts)
                logger.info(f'Extracted content from output array, length={len(content)}')
                return content

        logger.warning('No content found in OpenAI response (neither output_text nor output array)')
        return ''

    def synthesize_research(
        self, research_content, post_content, ideas_content, user_profile: dict, job_id: str | None, user_id: str | None
    ) -> dict[str, Any]:
        """
        Synthesize research into a LinkedIn post.

        Args:
            research_content: Research findings
            post_content: Existing draft content
            ideas_content: Selected ideas
            user_profile: User profile
            job_id: Job ID for tracking
            user_id: User ID

        Returns:
            dict with success status
        """
        try:
            if not job_id:
                return {'success': False, 'error': 'Missing required field: job_id'}

            # Clear stale synthesized post at handler entry so the UI never
            # shows the previous synthesis while a new one is being generated.
            self._persist_profile_field(user_id, 'ai_synthesized_post', None)

            user_data = ''
            if isinstance(user_profile, dict) and user_profile.get('name') != PROFILE_PLACEHOLDER_NAME:
                user_data = self._format_user_profile_context(user_profile)

            research_text = self._normalize_content(research_content)
            post_text = self._normalize_content(post_content)

            llm_prompt = SYNTHESIZE_RESEARCH_PROMPT.format(
                user_data=user_data,
                research_content=research_text,
                post_content=post_text,
                ideas_content=self._sanitize_prompt(str(ideas_content) if ideas_content else '', 3000),
            )

            response = self.openai_client.responses.create(
                model='gpt-5.2',
                input=llm_prompt,
                timeout=OPERATION_TIMEOUTS.get('synthesize_research', 60),
            )

            content = self._extract_response_content(response)

            if not content or not content.strip():
                logger.error('synthesize_research returned empty content from OpenAI')
                return {'success': False, 'error': 'OpenAI returned empty content'}

            synthesized = content.strip()
            # dynamodb-api's profile service rejects ai_synthesized_post
            # values longer than 10,000 characters
            # (see dynamodb_api_service.py validator). Enforce the same
            # cap here so a runaway model output doesn't write a value
            # that later fails validation on read.
            max_synthesized_len = 10000
            if len(synthesized) > max_synthesized_len:
                logger.warning(
                    'synthesize_research output exceeded %s chars; truncating',
                    max_synthesized_len,
                )
                synthesized = synthesized[:max_synthesized_len]
            self._persist_profile_field(user_id, 'ai_synthesized_post', synthesized)
            return {'success': True, 'content': synthesized}

        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in synthesize_research: {e}')
            return {'success': False, 'error': 'Failed to synthesize research into post'}
        except Exception as e:
            logger.error(f'Error in synthesize_research: {e}')
            return {'success': False, 'error': 'Failed to synthesize research into post'}

    def generate_message(
        self,
        connection_profile: dict,
        conversation_topic: str,
        user_profile: dict | None = None,
        message_history: list | None = None,
        connection_id: str | None = None,
        mode: str = 'standard',
        connection_notes: list | None = None,
    ) -> dict[str, Any]:
        """
        Generate a personalized LinkedIn message for a connection.

        Args:
            connection_profile: Recipient profile data (firstName, lastName, position, company, headline, tags)
            conversation_topic: Topic the user wants to discuss
            user_profile: Sender's profile data for context
            message_history: Previous messages with this connection
            connection_id: Raw profile slug for optional DynamoDB enrichment
            mode: "standard" for regular message, "icebreaker" for first-contact suggestions
            connection_notes: List of note objects with 'content' field (for icebreaker mode)

        Returns:
            dict with generatedMessage (standard) or icebreakers (icebreaker)
        """
        try:
            # Build sender context
            sender_data = ''
            if user_profile:
                sender_data = self._format_user_profile_context(user_profile, skip_empty_values=True)

            # Build recipient context from request
            first_name = connection_profile.get('firstName', '')
            last_name = connection_profile.get('lastName', '')
            recipient_name = f'{first_name} {last_name}'.strip()
            recipient_position = connection_profile.get('position', '')
            recipient_company = connection_profile.get('company', '')
            recipient_headline = connection_profile.get('headline', '')
            raw_tags = connection_profile.get('tags') or []
            if not isinstance(raw_tags, list):
                raw_tags = []
            recipient_tags = ', '.join(str(t) for t in raw_tags)

            # Optionally enrich from DynamoDB profile metadata
            recipient_context = ''
            if connection_id and self.table:
                recipient_context = self._fetch_profile_context(connection_id)

            if mode == 'icebreaker':
                return self._generate_icebreaker(
                    sender_data=sender_data,
                    recipient_name=recipient_name,
                    recipient_position=recipient_position,
                    recipient_company=recipient_company,
                    recipient_headline=recipient_headline,
                    recipient_tags=recipient_tags,
                    recipient_context=recipient_context,
                    connection_notes=connection_notes,
                )

            # Standard mode
            # Format message history
            history_text = ''
            if message_history:
                for msg in message_history[:10]:  # Limit to last 10 messages
                    role = msg.get('type', 'unknown')
                    content = self._sanitize_prompt(msg.get('content', ''), 500)
                    history_text += f'{role}: {content}\n'
            if not history_text:
                history_text = 'No previous messages.'

            llm_prompt = GENERATE_MESSAGE_PROMPT.format(
                sender_data=sender_data or 'No sender profile provided.',
                recipient_name=recipient_name or 'Unknown',
                recipient_position=self._sanitize_prompt(recipient_position, 200),
                recipient_company=self._sanitize_prompt(recipient_company, 200),
                recipient_headline=self._sanitize_prompt(recipient_headline, 300),
                recipient_tags=self._sanitize_prompt(recipient_tags, 500),
                recipient_context=recipient_context or 'No additional context available.',
                conversation_topic=self._sanitize_prompt(conversation_topic, 1000),
                message_history=history_text,
            )

            response = self.openai_client.responses.create(
                model='gpt-5.2',
                input=llm_prompt,
                timeout=OPERATION_TIMEOUTS.get('generate_message', 60),
            )

            content = self._extract_response_content(response)

            if not content or not content.strip():
                logger.error('generate_message returned empty content from OpenAI')
                return {'generatedMessage': '', 'confidence': 0, 'error': 'Empty response from AI'}

            return {'generatedMessage': content.strip(), 'confidence': 0.85}

        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in generate_message: {e}')
            return {'generatedMessage': '', 'confidence': 0, 'error': 'Failed to generate message'}
        except Exception as e:
            logger.error(f'Error in generate_message: {e}')
            return {'generatedMessage': '', 'confidence': 0, 'error': 'Failed to generate message'}

    def _generate_icebreaker(
        self,
        sender_data: str,
        recipient_name: str,
        recipient_position: str,
        recipient_company: str,
        recipient_headline: str,
        recipient_tags: str,
        recipient_context: str,
        connection_notes: list | None = None,
    ) -> dict[str, Any]:
        """Generate first-contact icebreaker suggestions using dedicated prompt."""

        try:
            # Format connection notes
            notes_text = 'No notes available.'
            if connection_notes:
                note_lines = []
                for note in connection_notes:
                    content = note.get('content', '') if isinstance(note, dict) else str(note)
                    if content:
                        note_lines.append(f'- {self._sanitize_prompt(content, 500)}')
                if note_lines:
                    notes_text = '\n'.join(note_lines)

            llm_prompt = GENERATE_ICEBREAKER_PROMPT.format(
                sender_data=sender_data or 'No sender profile provided.',
                recipient_name=recipient_name or 'Unknown',
                recipient_position=self._sanitize_prompt(recipient_position, 200),
                recipient_company=self._sanitize_prompt(recipient_company, 200),
                recipient_headline=self._sanitize_prompt(recipient_headline, 300),
                recipient_tags=self._sanitize_prompt(recipient_tags, 500),
                recipient_context=recipient_context or 'No additional context available.',
                connection_notes=notes_text,
            )

            response = self.openai_client.responses.create(
                model='gpt-5.2',
                input=llm_prompt,
                timeout=OPERATION_TIMEOUTS.get('generate_message', 60),
            )

            content = self._extract_response_content(response)

            if not content or not content.strip():
                logger.error('generate_icebreaker returned empty content from OpenAI')
                return {'icebreakers': [], 'error': 'Empty response from AI'}

            # Parse numbered list into individual icebreakers
            icebreakers = self._parse_icebreakers(content)

            return {'icebreakers': icebreakers}

        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in generate_icebreaker: {e}')
            return {'icebreakers': [], 'error': 'Failed to generate icebreakers'}
        except Exception as e:
            logger.error(f'Error in generate_icebreaker: {e}')
            return {'icebreakers': [], 'error': 'Failed to generate icebreakers'}

    @staticmethod
    def _parse_icebreakers(content: str) -> list[str]:
        """Parse numbered list response into individual icebreaker messages."""
        if not content:
            return []

        # Split by numbered list pattern (1. or 1) at line start)
        parts = re.split(r'^\s*\d+[\.\)]\s*', content, flags=re.MULTILINE)
        icebreakers = [part.strip() for part in parts if part.strip()]

        return icebreakers

    def analyze_message_patterns(self, stats: dict, sample_messages: list) -> dict[str, Any]:
        """Analyze message patterns via LLM and return actionable insights.

        Args:
            stats: Aggregate messaging stats from MessageIntelligenceService.
            sample_messages: List of outbound message dicts (content, got_response).

        Returns:
            Dict with insights list and analyzedAt timestamp.
        """
        try:
            # Format sample messages for the prompt (up to 20, truncated to 200 chars)
            formatted_samples = []
            for msg in sample_messages[:20]:
                content = self._sanitize_prompt(str(msg.get('content', ''))[:200], 200)
                got_response = 'got response' if msg.get('got_response') else 'no response'
                formatted_samples.append(f'- [{got_response}] {content}')

            sample_text = '\n'.join(formatted_samples) if formatted_samples else 'No sample messages available.'

            response_rate_pct = round((stats.get('responseRate', 0) or 0) * 100, 1)
            avg_time = stats.get('avgResponseTimeHours')
            avg_time_str = f'{avg_time:.1f} hours' if avg_time is not None else 'N/A'

            prompt = ANALYZE_MESSAGE_PATTERNS_PROMPT.format(
                total_outbound=stats.get('totalOutbound', 0),
                total_inbound=stats.get('totalInbound', 0),
                response_rate=response_rate_pct,
                avg_response_time=avg_time_str,
                sample_messages=sample_text,
            )

            response = self.openai_client.responses.create(
                model='gpt-4.1',
                input=prompt,
                timeout=OPERATION_TIMEOUTS.get('analyze_message_patterns', 60),
            )

            content = self._extract_response_content(response)

            # Parse numbered insights from response
            insights = []
            for line in content.strip().split('\n'):
                line = line.strip()
                if line:
                    # Strip leading number prefix (e.g. "1. ", "2) ", "3- ")
                    cleaned = re.sub(r'^\s*\d+[\.\)\-]?\s*', '', line)
                    if cleaned:
                        insights.append(cleaned)

            return {
                'insights': insights,
                'analyzedAt': datetime.now(UTC).isoformat(),
            }

        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in analyze_message_patterns: {e}')
            return {'insights': [], 'analyzedAt': datetime.now(UTC).isoformat(), 'error': str(e)}
        except Exception as e:
            logger.error(f'Error in analyze_message_patterns: {e}')
            return {'insights': [], 'analyzedAt': datetime.now(UTC).isoformat(), 'error': str(e)}

    def analyze_tone(self, draft_text, recipient_name='', recipient_position='', relationship_status=''):
        """Analyze the tone of a draft LinkedIn message.

        Args:
            draft_text: The draft message text to analyze.
            recipient_name: Name of the message recipient.
            recipient_position: Job title of the recipient.
            relationship_status: Connection status (e.g. ally, outgoing).

        Returns:
            Dict with professionalism, warmth, clarity, salesPressure (int 1-10),
            assessment and suggestion (str).
        """
        try:
            prompt = ANALYZE_TONE_PROMPT.format(
                draft_text=self._sanitize_prompt(draft_text),
                recipient_name=self._sanitize_prompt(recipient_name, 200),
                recipient_position=self._sanitize_prompt(recipient_position, 200),
                relationship_status=self._sanitize_prompt(relationship_status, 100),
            )

            response = self.openai_client.responses.create(
                model='gpt-4.1',
                input=prompt,
                timeout=OPERATION_TIMEOUTS.get('analyze_tone', 60),
            )

            content = self._extract_response_content(response)
            return self._parse_tone_response(content)

        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in analyze_tone: {e}')
            return {'error': 'Tone analysis failed'}
        except Exception as e:
            logger.error(f'Error in analyze_tone: {e}')
            return {'error': 'Tone analysis failed'}

    def _parse_tone_response(self, response_text: str) -> dict[str, Any]:
        """Parse structured tone analysis response into a dict."""
        defaults = {
            'professionalism': 5,
            'warmth': 5,
            'clarity': 5,
            'salesPressure': 5,
            'assessment': '',
            'suggestion': '',
        }

        if not response_text:
            return defaults

        result = {}

        score_fields = {
            'PROFESSIONALISM': 'professionalism',
            'WARMTH': 'warmth',
            'CLARITY': 'clarity',
            'SALES_PRESSURE': 'salesPressure',
        }

        for label, key in score_fields.items():
            match = re.search(rf'{label}:\s*(\d+)', response_text)
            if match:
                score = int(match.group(1))
                result[key] = max(1, min(10, score))
            else:
                result[key] = defaults[key]

        text_fields = {
            'ASSESSMENT': 'assessment',
            'SUGGESTION': 'suggestion',
        }

        for label, key in text_fields.items():
            match = re.search(rf'{label}:\s*(.+?)(?=\n[A-Z_]+:|$)', response_text, re.DOTALL)
            if match:
                result[key] = match.group(1).strip()
            else:
                result[key] = defaults[key]

        return result

    def _fetch_profile_context(self, connection_id: str) -> str:
        """Fetch enriched profile context from DynamoDB metadata."""
        from shared_services.edge_data_service import encode_profile_id

        try:
            profile_id_b64 = encode_profile_id(connection_id)
            response = self.table.get_item(Key={'PK': f'PROFILE#{profile_id_b64}', 'SK': '#METADATA'})
            item = response.get('Item')
            if not item:
                return ''

            parts = []
            if item.get('summary'):
                parts.append(f'About: {item["summary"][:1000]}')
            if item.get('skills'):
                skills = item['skills']
                if isinstance(skills, list):
                    parts.append(f'Skills: {", ".join(skills[:20])}')
            if item.get('workExperience'):
                exp = item['workExperience']
                if isinstance(exp, list) and exp:
                    recent = exp[0] if isinstance(exp[0], dict) else {}
                    title = recent.get('title', '')
                    company = recent.get('company', '')
                    if title or company:
                        parts.append(f'Recent experience: {title} at {company}')

            return '\n'.join(parts)

        except Exception as e:
            logger.debug(f'Could not fetch profile context for {connection_id}: {e}')
            return ''

    # Private helpers

    @staticmethod
    def _format_user_profile_context(profile: dict, skip_empty_values: bool = False) -> str:
        """Format a user profile dict into a key: value text block for LLM prompts.

        Excludes linkedin_credentials. When skip_empty_values is True, also
        excludes keys whose values are falsy.
        """
        if not profile:
            return ''
        parts = []
        for key, value in profile.items():
            if key == 'linkedin_credentials':
                continue
            if skip_empty_values and not value:
                continue
            parts.append(f'{key}: {value}')
        return '\n'.join(parts) + ('\n' if parts else '')

    def _sanitize_prompt(self, text: str, max_length: int = 2000) -> str:
        """Sanitize user-provided prompt text to prevent injection attacks."""
        if not text:
            return ''
        # Truncate to max length
        text = text[:max_length]
        # Strip control characters (keep newlines/tabs for readability)
        text = ''.join(c for c in text if c in '\n\t' or (ord(c) >= 32 and ord(c) != 127))
        # Escape curly braces to prevent .format() injection
        text = text.replace('{', '{{').replace('}', '}}')
        return text.strip()

    def _normalize_content(self, value) -> str:
        """Normalize content to string."""
        if value is None:
            return ''
        if isinstance(value, (dict, list)):
            try:
                return json.dumps(value, indent=2, ensure_ascii=False)
            except (TypeError, ValueError):
                return str(value)
        return str(value)
