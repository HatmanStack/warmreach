"""LLMService - Business logic for LLM operations."""

import json
import logging
import os
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

# Shared layer imports (from /opt/python via Lambda Layer)
import openai
from errors.exceptions import ExternalServiceError, ServiceError, ValidationError
from shared_services.base_service import BaseService

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


class LLMService(BaseService):
    """
    Service class for LLM-powered content generation operations.

    Handles idea generation, research, synthesis, and style transformations
    using OpenAI and AWS Bedrock with injected clients for testability.
    """

    def __init__(self, openai_client, bedrock_client=None, table=None, bedrock_model_id: str | None = None):
        """
        Initialize LLMService with injected dependencies.

        Args:
            openai_client: OpenAI client for GPT operations
            bedrock_client: Bedrock client for Claude operations (optional)
            table: DynamoDB Table resource for result storage (optional)
            bedrock_model_id: Bedrock model ID for style operations
        """
        super().__init__()
        self.openai_client = openai_client
        self.bedrock_client = bedrock_client
        self.table = table
        self.bedrock_model_id = bedrock_model_id or os.environ.get(
            'BEDROCK_MODEL_ID', 'anthropic.claude-3-sonnet-20240229-v1:0'
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

            return {'success': True, 'ideas': ideas}

        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in generate_ideas: {e}')
            raise ExternalServiceError(
                message='Failed to generate ideas', service='OpenAI', original_error=str(e)
            ) from e
        except Exception as e:
            logger.error(f'Error in generate_ideas: {e}')
            raise ServiceError(message='Failed to generate ideas') from e

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
        try:
            if not selected_ideas:
                raise ValidationError(message='No ideas selected for research')

            job_id = str(uuid.uuid4())

            formatted_user_data = ''
            if user_data and user_data.get('name') != PROFILE_PLACEHOLDER_NAME:
                formatted_user_data = self._format_user_profile_context(user_data)

            formatted_topics = '\n'.join([f'- {self._sanitize_prompt(idea, 500)}' for idea in selected_ideas])

            research_prompt = LINKEDIN_RESEARCH_PROMPT.format(topics=formatted_topics, user_data=formatted_user_data)

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

            # Store the OpenAI response_id so we can poll it later (7-day TTL)
            response_id = response.id
            if self.table:
                self.table.put_item(
                    Item={
                        'PK': f'USER#{user_id}',
                        'SK': f'RESEARCH#{job_id}',
                        'openai_response_id': response_id,
                        'status': 'in_progress',
                        'created_at': datetime.now(UTC).isoformat(),
                        'ttl': int((datetime.now(UTC) + timedelta(days=7)).timestamp()),
                    }
                )

            return {
                'success': True,
                'job_id': job_id,
            }

        except (ValidationError, ExternalServiceError, ServiceError):
            raise
        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in research_selected_ideas: {e}')
            raise ExternalServiceError(
                message='Failed to research selected ideas', service='OpenAI', original_error=str(e)
            ) from e
        except Exception as e:
            logger.error(f'Error in research_selected_ideas: {e}')
            raise ServiceError(message='Failed to research selected ideas') from e

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
        """Check OpenAI response status and store result if complete."""
        try:
            resp = self.openai_client.responses.retrieve(response_id)
            status = getattr(resp, 'status', None)
            logger.info(f'OpenAI response status for {response_id}: {status}')

            if status != 'completed':
                return {'success': False, 'status': status or 'pending'}

            content = self._extract_response_content(resp)

            if not content or not content.strip():
                logger.error(f'OpenAI response {response_id} completed but returned empty content')
                return {'success': False, 'error': 'OpenAI returned empty content'}

            content = content.strip()

            # Update DynamoDB with the completed result
            if self.table:
                self.table.update_item(
                    Key={'PK': f'USER#{user_id}', 'SK': f'{kind}#{job_id}'},
                    UpdateExpression='SET content = :c, #s = :s',
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={':c': content, ':s': 'completed'},
                )

            return {'success': True, 'content': content}

        except Exception as e:
            logger.error(f'Error checking OpenAI response: {e}')
            return {'success': False}

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
                raise ValidationError(message='Missing required field: job_id')

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
                raise ExternalServiceError(message='OpenAI returned empty content', service='OpenAI')

            return {'success': True, 'content': content.strip()}

        except (ValidationError, ExternalServiceError, ServiceError):
            raise
        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in synthesize_research: {e}')
            raise ExternalServiceError(
                message='Failed to synthesize research into post', service='OpenAI', original_error=str(e)
            ) from e
        except Exception as e:
            logger.error(f'Error in synthesize_research: {e}')
            raise ServiceError(message='Failed to synthesize research into post') from e

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
                return {'generatedMessage': '', 'error': 'Empty response from AI'}

            return {'generatedMessage': content.strip()}

        except (ValidationError, ExternalServiceError, ServiceError):
            raise
        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in generate_message: {e}')
            raise ExternalServiceError(
                message='Failed to generate message', service='OpenAI', original_error=str(e)
            ) from e
        except Exception as e:
            logger.error(f'Error in generate_message: {e}')
            raise ServiceError(message='Failed to generate message') from e

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

        except (ValidationError, ExternalServiceError, ServiceError):
            raise
        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in generate_icebreaker: {e}')
            raise ExternalServiceError(
                message='Failed to generate icebreakers', service='OpenAI', original_error=str(e)
            ) from e
        except Exception as e:
            logger.error(f'Error in generate_icebreaker: {e}')
            raise ServiceError(message='Failed to generate icebreakers') from e

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

        except (ValidationError, ExternalServiceError, ServiceError):
            raise
        except (openai.APIError, openai.APITimeoutError, openai.RateLimitError) as e:
            logger.error(f'OpenAI API error in analyze_message_patterns: {e}')
            raise ExternalServiceError(
                message='Failed to analyze message patterns', service='OpenAI', original_error=str(e)
            ) from e
        except Exception as e:
            logger.error(f'Error in analyze_message_patterns: {e}')
            raise ServiceError(message='Failed to analyze message patterns') from e

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
            raise ExternalServiceError(message='Tone analysis failed', service='OpenAI', original_error=str(e)) from e
        except Exception as e:
            logger.error(f'Error in analyze_tone: {e}')
            raise ServiceError(message='Tone analysis failed') from e

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
