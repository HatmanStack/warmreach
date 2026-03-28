import { analyticsApiService } from '@/shared/services/analyticsApiService';
import { httpClient } from '@/shared/utils/httpClient';
import { v4 as uuidv4 } from 'uuid';
import type { UserProfile } from '@/types';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('PostsService');

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
    try {
      const profileToSend = sanitizeProfileForBackend(userProfile);

      const jobId = uuidv4();
      const response = await analyticsApiService.sendLLMRequest('generate_ideas', {
        prompt: prompt || '',
        user_profile: profileToSend,
        job_id: jobId,
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to generate ideas');
      }

      const data = response.data as Record<string, unknown> | undefined;
      const ideas =
        (data?.ideas as string[]) ||
        ((response as unknown as Record<string, unknown>).ideas as string[] | undefined);
      if (Array.isArray(ideas) && ideas.length > 0) {
        return ideas;
      }

      throw new Error('No ideas returned from backend');
    } catch (error) {
      logger.error('Error generating ideas', { error });
      throw error instanceof Error ? error : new Error('Failed to generate ideas');
    }
  },

  async researchTopics(topics: string[], userProfile?: UserProfile): Promise<string> {
    try {
      const filteredProfile = sanitizeProfileForBackend(userProfile);
      const response = await analyticsApiService.sendLLMRequest('research_selected_ideas', {
        selected_ideas: topics,
        user_profile: filteredProfile,
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to research topics');
      }
      const responseData = response.data as Record<string, unknown> | undefined;
      const jobId: string | undefined =
        (responseData?.job_id as string) || (responseData?.jobId as string);
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
          const poll = await httpClient.makeRequest<{
            content?: string;
            status?: string;
          }>('llm', 'get_research_result', {
            job_id: jobId,
            kind: 'RESEARCH',
          });
          if (poll && poll.success === true) {
            const pollData = poll as Record<string, unknown>;
            const nestedData = (pollData.data as Record<string, unknown>) ?? undefined;
            const content = (nestedData?.content as string) || '';
            if (content && typeof content === 'string' && content.trim().length > 0) {
              return content;
            }
          }
        } catch {
          // ignore transient errors and continue polling
        }
        if (i < maxChecks - 1) await sleep(intervalMs);
      }
      throw new Error('Deep research polling timed out');
    } catch (error) {
      logger.error('Error researching topics', { error });
      throw new Error('Failed to research topics');
    }
  },

  async synthesizeResearch(
    payload: { existing_content: string; research_content?: string; selected_ideas?: string[] },
    userProfile?: UserProfile
  ): Promise<{ content: string }> {
    try {
      const profileToSend = sanitizeProfileForBackend(userProfile);

      const jobId = uuidv4();
      const response = await analyticsApiService.sendLLMRequest('synthesize_research', {
        existing_content: payload.existing_content,
        research_content: payload.research_content ?? null,
        selected_ideas:
          Array.isArray(payload.selected_ideas) && payload.selected_ideas.length > 0
            ? payload.selected_ideas
            : [],
        user_profile: profileToSend,
        job_id: jobId,
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to synthesize research');
      }

      const data = response.data as Record<string, unknown> | undefined;
      const content = (data?.content as string) || '';
      if (content.trim()) {
        return { content: content.trim() };
      }

      throw new Error('No synthesis result returned from backend');
    } catch (error) {
      logger.error('Error synthesizing research', { error });
      throw error instanceof Error ? error : new Error('Failed to synthesize research');
    }
  },
};
