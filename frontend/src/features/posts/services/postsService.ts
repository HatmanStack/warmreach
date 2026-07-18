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

const ActiveResearchResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      active: z.boolean().optional(),
      status: z.string().optional(),
      job_id: z.string().optional(),
      selected_ideas: z.array(z.string()).optional(),
      content: z.string().optional(),
    })
    .optional(),
});

export interface ActiveResearch {
  active: boolean;
  status?: string;
  jobId?: string;
  selectedIdeas?: string[];
  content?: string;
}

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
    ai_synthesized_post,
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
  void ai_synthesized_post;
  void ai_generated_ideas;
  void ai_generated_research;
  void ai_generated_post_hook;
  void ai_generated_post_reasoning;
  void linkedin_credentials;

  return rest;
}

// Deep research (o4-mini / o3) typically takes 5-30+ minutes to complete.
const RESEARCH_POLL_INTERVAL_MS = 15_000;
const RESEARCH_MAX_POLLS = 200; // ~50 minutes

/**
 * setTimeout-based sleep that rejects with an AbortError the moment `signal`
 * aborts, so a Cancel can interrupt the long poll loop instead of waiting out
 * the current 15s tick.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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

  /**
   * Kick off a deep-research job and return its job_id. The backend persists a
   * discoverable RESEARCH# row before the OpenAI call returns, so the job
   * survives a refresh even mid-kickoff.
   */
  async startResearch(topics: string[], userProfile?: UserProfile): Promise<string> {
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
    return jobId;
  },

  /**
   * Poll a research job until its content is ready. Honors an AbortSignal so a
   * Cancel (or unmount) interrupts the loop immediately; aborting rethrows an
   * AbortError the caller can distinguish from a genuine timeout/failure.
   */
  async pollResearchResult(
    jobId: string,
    options: { signal?: AbortSignal; correlationId?: string } = {}
  ): Promise<string> {
    const { signal } = options;
    const correlationId = options.correlationId ?? uuidv4();

    for (let i = 0; i < RESEARCH_MAX_POLLS; i++) {
      // Wait first (the job is never ready instantly), aborting if cancelled.
      await abortableSleep(RESEARCH_POLL_INTERVAL_MS, signal);

      let terminalStatus: string | undefined;
      try {
        const rawPoll = await httpClient.makeRequest<unknown>(
          'llm',
          'get_research_result',
          { job_id: jobId, kind: 'RESEARCH', correlation_id: correlationId },
          { signal }
        );
        const poll = ResearchPollResponseSchema.parse(rawPoll);
        const status = poll.data?.status;
        if (status && ['failed', 'cancelled', 'expired'].includes(status)) {
          // The backend resolved the job terminally — record it so we stop below
          // instead of polling for ~50 min to a generic timeout.
          terminalStatus = status;
        } else if (poll.success === true) {
          const content = poll.data?.content ?? '';
          if (content.trim().length > 0) {
            return content;
          }
        }
      } catch (pollError) {
        if (isAbortError(pollError) || signal?.aborted) {
          throw pollError instanceof Error ? pollError : new DOMException('Aborted', 'AbortError');
        }
        // Non-abort polling errors are logged but retried — a sustained schema
        // or auth failure should be visible rather than silently swallowed.
        logger.warn('Research poll attempt failed', {
          correlationId,
          attempt: i + 1,
          error: pollError instanceof Error ? pollError.message : String(pollError),
        });
      }
      // Thrown outside the try so the retry catch above can't swallow it.
      if (terminalStatus) {
        throw new Error(`Research ${terminalStatus}`);
      }
    }
    throw new Error('Deep research polling timed out');
  },

  /**
   * Start a research job and poll it to completion. `onJobId` fires as soon as
   * the job exists so the caller can retain the id (e.g. to cancel it); `signal`
   * cancels the poll. An AbortError propagates unwrapped so callers can treat a
   * cancel differently from a failure.
   */
  async researchTopics(
    topics: string[],
    userProfile?: UserProfile,
    options: { signal?: AbortSignal; onJobId?: (jobId: string) => void } = {}
  ): Promise<string> {
    const correlationId = uuidv4();
    let jobId: string;
    try {
      jobId = await this.startResearch(topics, userProfile);
    } catch (error) {
      logger.error('Error starting research', { error, correlationId });
      throw new Error('Failed to research topics');
    }
    options.onJobId?.(jobId);

    // Cancel raced the kickoff: the user aborted before we had a job_id, so the
    // POST completed and the OpenAI job was created anyway. Cancel it now so it
    // can't run to completion and be mirrored back in by the reconciler.
    if (options.signal?.aborted) {
      await this.cancelResearch(jobId).catch((err) =>
        logger.warn('cancel after aborted kickoff failed', { error: err, correlationId })
      );
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      return await this.pollResearchResult(jobId, { signal: options.signal, correlationId });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      logger.error('Error researching topics', { error, correlationId });
      throw new Error('Failed to research topics');
    }
  },

  /**
   * Ask the backend for the user's most recent active research job. Used by
   * resume-on-load after a refresh, when the browser no longer holds the
   * job_id. The backend reconciles the job against OpenAI as a side effect, so
   * a job that completed while nobody was polling gets persisted here too.
   */
  async getActiveResearch(): Promise<ActiveResearch> {
    try {
      const raw = await httpClient.makeRequest<unknown>('llm', 'get_active_research', {});
      const parsed = ActiveResearchResponseSchema.parse(raw);
      if (!parsed.success) {
        return { active: false };
      }
      const data = parsed.data;
      return {
        active: Boolean(data?.active),
        status: data?.status,
        jobId: data?.job_id,
        selectedIdeas: data?.selected_ideas,
        content: data?.content,
      };
    } catch (error) {
      logger.warn('getActiveResearch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { active: false };
    }
  },

  /** Cancel an in-progress research job (best-effort; also cancels on OpenAI). */
  async cancelResearch(jobId: string): Promise<void> {
    const response = await analyticsApiService.sendLLMRequest('cancel_research', { job_id: jobId });
    // `response.success` is transport-level (true for any HTTP 200); the backend's
    // own {success:false,error} lives under `data`. Check both so a failed cancel
    // (row missing / DynamoDB error) surfaces instead of silently "succeeding" and
    // letting the reconciler resurrect the job.
    const body = (response.data ?? {}) as { success?: boolean; error?: string };
    if (!response.success || body.success === false) {
      throw new Error(body.error || response.error || 'Failed to cancel research');
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
