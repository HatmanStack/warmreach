import { z } from 'zod';
import { analyticsApiService } from '@/shared/services/analyticsApiService';
import { httpClient } from '@/shared/utils/httpClient';
import { v4 as uuidv4 } from 'uuid';
import type { UserProfile } from '@/types';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('PostsService');

// --- Response schemas ------------------------------------------------------
// Each LLM operation returns `{ success, data, ...rest }`. We validate the
// parts we actually read. `.strip()` (zod's default) drops unknown fields so a
// server-side addition (e.g. new PII columns) cannot leak through the
// historical `as unknown as Record<string, unknown>` escape hatch.

const GenerateIdeasDataSchema = z.object({
  ideas: z.array(z.string()).optional(),
});

const GenerateIdeasResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: GenerateIdeasDataSchema.optional(),
  // Some legacy backends bubble `ideas` at the top level.
  ideas: z.array(z.string()).optional(),
});

const ResearchStartResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z
    .object({
      job_id: z.string().optional(),
      jobId: z.string().optional(),
    })
    .optional(),
});

const ResearchPollResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      content: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
});

const SynthesisResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z
    .object({
      content: z.string().optional(),
    })
    .optional(),
});

/**
 * Remove sensitive/temporary fields before sending profile to backend.
 */
function sanitizeProfileForBackend(userProfile?: UserProfile): Record<string, unknown> | null {
  if (!userProfile) return null;

  const profile = userProfile as Record<string, unknown>;
  const {
    unsent_post_content,
    unpublished_post_content,
    ai_generated_post_content,
    ai_generated_ideas,
    ai_generated_research,
    ai_generated_post_hook,
    ai_generated_post_reasoning,
    linkedin_credentials,
    ...rest
  } = profile;

  void unsent_post_content;
  void unpublished_post_content;
  void ai_generated_post_content;
  void ai_generated_ideas;
  void ai_generated_research;
  void ai_generated_post_hook;
  void ai_generated_post_reasoning;
  void linkedin_credentials;

  return rest;
}

export const postsService = {
  async generateIdeas(prompt?: string, userProfile?: UserProfile): Promise<string[]> {
    const correlationId = uuidv4();
    try {
      const profileToSend = sanitizeProfileForBackend(userProfile);

      const rawResponse = await analyticsApiService.sendLLMRequest('generate_ideas', {
        prompt: prompt || '',
        user_profile: profileToSend,
        job_id: correlationId,
      });

      const response = GenerateIdeasResponseSchema.parse(rawResponse);

      if (!response.success) {
        throw new Error(response.error || 'Failed to generate ideas');
      }

      const ideas = response.data?.ideas ?? response.ideas;
      if (Array.isArray(ideas) && ideas.length > 0) {
        return ideas;
      }

      throw new Error('No ideas returned from backend');
    } catch (error) {
      logger.error('Error generating ideas', { error, correlationId });
      throw error instanceof Error ? error : new Error('Failed to generate ideas');
    }
  },

  async researchTopics(topics: string[], userProfile?: UserProfile): Promise<string> {
    const correlationId = uuidv4();
    try {
      const filteredProfile = sanitizeProfileForBackend(userProfile);
      const rawResponse = await analyticsApiService.sendLLMRequest('research_selected_ideas', {
        selected_ideas: topics,
        user_profile: filteredProfile,
      });

      const response = ResearchStartResponseSchema.parse(rawResponse);

      if (!response.success) {
        throw new Error(response.error || 'Failed to research topics');
      }

      const jobId = response.data?.job_id ?? response.data?.jobId;
      if (!jobId) {
        throw new Error('No job_id returned for research request');
      }

      // Poll for deep research results (backend checks OpenAI response status)
      // Deep research (o4-mini / o3) typically takes 5-30+ minutes to complete
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const intervalMs = 15_000;
      const maxChecks = 200;

      await sleep(intervalMs);
      for (let i = 0; i < maxChecks; i++) {
        try {
          const rawPoll = await httpClient.makeRequest<unknown>('llm', 'get_research_result', {
            job_id: jobId,
            kind: 'RESEARCH',
            correlation_id: correlationId,
          });
          const poll = ResearchPollResponseSchema.parse(rawPoll);
          if (poll.success === true) {
            const content = poll.data?.content ?? '';
            if (content.trim().length > 0) {
              return content;
            }
          }
        } catch (pollError) {
          // Non-timeout polling errors are worth surfacing in logs even though
          // we continue to retry — a sustained schema or auth failure should
          // be visible rather than hidden.
          logger.warn('Research poll attempt failed', {
            correlationId,
            attempt: i + 1,
            error: pollError instanceof Error ? pollError.message : String(pollError),
          });
        }
        if (i < maxChecks - 1) await sleep(intervalMs);
      }
      throw new Error('Deep research polling timed out');
    } catch (error) {
      logger.error('Error researching topics', { error, correlationId });
      throw new Error('Failed to research topics');
    }
  },

  async synthesizeResearch(
    payload: { existing_content: string; research_content?: string; selected_ideas?: string[] },
    userProfile?: UserProfile
  ): Promise<{ content: string }> {
    const correlationId = uuidv4();
    try {
      const profileToSend = sanitizeProfileForBackend(userProfile);

      const rawResponse = await analyticsApiService.sendLLMRequest('synthesize_research', {
        existing_content: payload.existing_content,
        research_content: payload.research_content ?? null,
        selected_ideas:
          Array.isArray(payload.selected_ideas) && payload.selected_ideas.length > 0
            ? payload.selected_ideas
            : [],
        user_profile: profileToSend,
        job_id: correlationId,
      });

      const response = SynthesisResponseSchema.parse(rawResponse);

      if (!response.success) {
        throw new Error(response.error || 'Failed to synthesize research');
      }

      const content = response.data?.content ?? '';
      if (content.trim()) {
        return { content: content.trim() };
      }

      throw new Error('No synthesis result returned from backend');
    } catch (error) {
      logger.error('Error synthesizing research', { error, correlationId });
      throw error instanceof Error ? error : new Error('Failed to synthesize research');
    }
  },
};
