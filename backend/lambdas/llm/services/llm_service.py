"""LLMService - Business logic for LLM operations."""

import json
import logging
import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

# Shared layer imports (from /opt/python via Lambda Layer)
from shared_services.base_service import BaseService

try:
    from prompts import (
        ANALYZE_MESSAGE_PATTERNS_PROMPT,
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
    ANALYZE_MESSAGE_PATTERNS_PROMPT = (
        '{total_outbound}\n{total_inbound}\n{response_rate}\n{avg_response_time}\n{sample_messages}'
    )

logger = logging.getLogger(__name__)

# Placeholder name used for demo/test profiles that should be skipped
PROFILE_PLACEHOLDER_NAME = 'Tom, Dick, And Harry'


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
                for key, value in user_profile.items():
                    if key != 'linkedin_credentials':
                        user_data += f'{key}: {value}\n'

            llm_prompt = LINKEDIN_IDEAS_PROMPT.format(
                user_data=user_data, raw_ideas=self._sanitize_prompt(prompt or '')
            )

            response = self.openai_client.responses.create(
                model='gpt-5.2',
                input=llm_prompt,
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

        except Exception as e:
            logger.error(f'Error in generate_ideas: {e}')
            return {'success': False, 'error': 'Failed to generate ideas'}

    def _parse_ideas(self, content: str) -> list[str]:
        """Parse ideas from LLM response text."""
        import re

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
                return {'success': False, 'error': 'No ideas selected for research'}

            job_id = str(uuid.uuid4())

            formatted_user_data = ''
            if user_data and user_data.get('name') != PROFILE_PLACEHOLDER_NAME:
                for key, value in user_data.items():
                    if key != 'linkedin_credentials':
                        formatted_user_data += f'{key}: {value}\n'

            formatted_topics = '\n'.join([f'- {self._sanitize_prompt(idea, 500)}' for idea in selected_ideas])

            research_prompt = LINKEDIN_RESEARCH_PROMPT.format(topics=formatted_topics, user_data=formatted_user_data)

            response = self.openai_client.responses.create(
                model='o4-mini-deep-research',
                input=research_prompt,
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

        except Exception as e:
            logger.error(f'Error in research_selected_ideas: {e}')
            return {'success': False, 'error': 'Failed to research selected ideas'}

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
                return {'success': False, 'error': 'Missing required field: job_id'}

            user_data = ''
            if isinstance(user_profile, dict) and user_profile.get('name') != PROFILE_PLACEHOLDER_NAME:
                for key, value in user_profile.items():
                    if key != 'linkedin_credentials':
                        user_data += f'{key}: {value}\n'

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
            )

            content = self._extract_response_content(response)

            if not content or not content.strip():
                logger.error('synthesize_research returned empty content from OpenAI')
                return {'success': False, 'error': 'OpenAI returned empty content'}

            return {'success': True, 'content': content.strip()}

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
    ) -> dict[str, Any]:
        """
        Generate a personalized LinkedIn message for a connection.

        Args:
            connection_profile: Recipient profile data (firstName, lastName, position, company, headline, tags)
            conversation_topic: Topic the user wants to discuss
            user_profile: Sender's profile data for context
            message_history: Previous messages with this connection
            connection_id: Raw profile slug for optional DynamoDB enrichment

        Returns:
            dict with generatedMessage and confidence
        """
        try:
            # Build sender context
            sender_data = ''
            if user_profile:
                for key, value in user_profile.items():
                    if value and key != 'linkedin_credentials':
                        sender_data += f'{key}: {value}\n'

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
            )

            content = self._extract_response_content(response)

            if not content or not content.strip():
                logger.error('generate_message returned empty content from OpenAI')
                return {'generatedMessage': '', 'confidence': 0, 'error': 'Empty response from AI'}

            return {'generatedMessage': content.strip(), 'confidence': 0.85}

        except Exception as e:
            logger.error(f'Error in generate_message: {e}')
            return {'generatedMessage': '', 'confidence': 0, 'error': 'Failed to generate message'}

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
            )

            content = self._extract_response_content(response)

            # Parse numbered insights from response
            import re

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

        except Exception as e:
            logger.error(f'Error in analyze_message_patterns: {e}')
            return {'insights': [], 'analyzedAt': datetime.now(UTC).isoformat(), 'error': str(e)}

    def _fetch_profile_context(self, connection_id: str) -> str:
        """Fetch enriched profile context from DynamoDB metadata."""
        import base64

        try:
            profile_id_b64 = base64.urlsafe_b64encode(connection_id.encode()).decode()
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
            except Exception:
                return str(value)
        return str(value)
