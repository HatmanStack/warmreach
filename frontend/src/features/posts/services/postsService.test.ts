import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserProfile } from '@/types';

const { mockSendLLMRequest, mockMakeRequest } = vi.hoisted(() => ({
  mockSendLLMRequest: vi.fn(),
  mockMakeRequest: vi.fn(),
}));

vi.mock('@/shared/services/analyticsApiService', () => ({
  analyticsApiService: {
    sendLLMRequest: mockSendLLMRequest,
  },
}));

vi.mock('@/shared/utils/httpClient', () => ({
  httpClient: {
    makeRequest: mockMakeRequest,
  },
}));

vi.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { postsService } from './postsService';

const mockProfile = {
  firstName: 'John',
  lastName: 'Doe',
  headline: 'Engineer',
  linkedin_credentials: 'sealbox_x25519:b64:secret',
  ai_generated_ideas: ['old idea'],
  ai_generated_research: 'old research',
} as unknown as UserProfile;

describe('postsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateIdeas', () => {
    it('should return ideas on success', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { ideas: ['Idea 1', 'Idea 2', 'Idea 3'] },
      });

      const ideas = await postsService.generateIdeas('tech leadership', mockProfile);

      expect(ideas).toEqual(['Idea 1', 'Idea 2', 'Idea 3']);
      expect(mockSendLLMRequest).toHaveBeenCalledWith(
        'generate_ideas',
        expect.objectContaining({
          prompt: 'tech leadership',
          job_id: 'test-uuid-1234',
        })
      );
    });

    it('should sanitize profile before sending', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { ideas: ['Idea 1'] },
      });

      await postsService.generateIdeas('prompt', mockProfile);

      const sentProfile = mockSendLLMRequest.mock.calls[0][1].user_profile;
      expect(sentProfile).not.toHaveProperty('linkedin_credentials');
      expect(sentProfile).not.toHaveProperty('ai_generated_ideas');
      expect(sentProfile).not.toHaveProperty('ai_generated_research');
      expect(sentProfile).toHaveProperty('firstName', 'John');
    });

    it('should throw on API failure', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: false,
        error: 'Rate limit exceeded',
      });

      await expect(postsService.generateIdeas('prompt')).rejects.toThrow('Rate limit exceeded');
    });

    it('should throw when no ideas returned', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { ideas: [] },
      });

      await expect(postsService.generateIdeas('prompt')).rejects.toThrow('No ideas returned');
    });

    it('should handle null profile', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { ideas: ['Idea 1'] },
      });

      await postsService.generateIdeas('prompt', undefined);

      expect(mockSendLLMRequest.mock.calls[0][1].user_profile).toBeNull();
    });
  });

  describe('researchTopics', () => {
    it('should poll and return research content', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { job_id: 'job-123' },
      });
      mockMakeRequest.mockResolvedValue({
        success: true,
        data: { content: 'Deep research results about AI trends' },
      });

      // Use fake timers to avoid waiting 15s
      vi.useFakeTimers();
      const promise = postsService.researchTopics(['AI trends'], mockProfile);
      // Advance through the initial sleep + first poll
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await promise;
      vi.useRealTimers();

      expect(result).toBe('Deep research results about AI trends');
    });

    it('should throw when no job_id returned', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: {},
      });

      await expect(postsService.researchTopics(['topic'])).rejects.toThrow(
        'Failed to research topics'
      );
    });

    it('should throw on initial request failure', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: false,
        error: 'Service unavailable',
      });

      await expect(postsService.researchTopics(['topic'])).rejects.toThrow(
        'Failed to research topics'
      );
    });

    it('should sanitize profile for research', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { job_id: 'job-456' },
      });
      mockMakeRequest.mockResolvedValue({
        success: true,
        data: { content: 'results' },
      });

      vi.useFakeTimers();
      const promise = postsService.researchTopics(['topic'], mockProfile);
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;
      vi.useRealTimers();

      const sentProfile = mockSendLLMRequest.mock.calls[0][1].user_profile;
      expect(sentProfile).not.toHaveProperty('linkedin_credentials');
    });

    it('invokes onJobId with the started job id before polling', async () => {
      mockSendLLMRequest.mockResolvedValue({ success: true, data: { job_id: 'job-cb' } });
      mockMakeRequest.mockResolvedValue({ success: true, data: { content: 'done' } });
      const onJobId = vi.fn();

      vi.useFakeTimers();
      const promise = postsService.researchTopics(['topic'], mockProfile, { onJobId });
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;
      vi.useRealTimers();

      expect(onJobId).toHaveBeenCalledWith('job-cb');
    });

    it('cancels the job when the signal aborts during kickoff', async () => {
      // start returns job_id, cancel returns success; distinguish by operation.
      mockSendLLMRequest.mockImplementation((operation: string) =>
        operation === 'research_selected_ideas'
          ? { success: true, data: { job_id: 'job-race' } }
          : { success: true, data: { success: true } }
      );
      const controller = new AbortController();
      controller.abort(); // aborted before we ever get a job_id

      await expect(
        postsService.researchTopics(['topic'], mockProfile, { signal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError' });

      // The kickoff created the job, so we must cancel it rather than leave it running.
      expect(mockSendLLMRequest).toHaveBeenCalledWith('cancel_research', { job_id: 'job-race' });
    });
  });

  describe('startResearch', () => {
    it('returns the job_id on success', async () => {
      mockSendLLMRequest.mockResolvedValue({ success: true, data: { job_id: 'job-abc' } });
      await expect(postsService.startResearch(['topic'], mockProfile)).resolves.toBe('job-abc');
    });

    it('throws when no job_id is returned', async () => {
      mockSendLLMRequest.mockResolvedValue({ success: true, data: {} });
      await expect(postsService.startResearch(['topic'])).rejects.toThrow(
        'No job_id returned for research request'
      );
    });
  });

  describe('pollResearchResult', () => {
    it('rejects with an AbortError when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        postsService.pollResearchResult('job-1', { signal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError' });
      // No poll should have gone out — we bailed on the first sleep.
      expect(mockMakeRequest).not.toHaveBeenCalled();
    });

    it('rejects with an AbortError when aborted mid-wait', async () => {
      const controller = new AbortController();
      vi.useFakeTimers();
      const promise = postsService.pollResearchResult('job-1', { signal: controller.signal });
      // Attach a rejection handler synchronously so aborting doesn't surface as
      // an unhandled rejection before we assert on it.
      const settled = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await settled;
      vi.useRealTimers();
    });

    it('stops immediately when the backend reports a terminal status', async () => {
      mockMakeRequest.mockResolvedValue({ success: true, data: { status: 'failed' } });
      vi.useFakeTimers();
      const promise = postsService.pollResearchResult('job-1');
      const settled = expect(promise).rejects.toThrow('Research failed');
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
      vi.useRealTimers();
      // Exactly one poll — it did not keep looping to the ~50min timeout.
      expect(mockMakeRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('getActiveResearch', () => {
    it('maps an active job response', async () => {
      mockMakeRequest.mockResolvedValue({
        success: true,
        data: {
          success: true,
          active: true,
          status: 'in_progress',
          job_id: 'job-9',
          selected_ideas: ['idea one'],
        },
      });

      const active = await postsService.getActiveResearch();
      expect(active).toEqual({
        active: true,
        status: 'in_progress',
        jobId: 'job-9',
        selectedIdeas: ['idea one'],
        content: undefined,
      });
    });

    it('returns inactive on an HTTP failure (e.g. feature gated)', async () => {
      mockMakeRequest.mockResolvedValue({
        success: false,
        error: { message: 'gated', code: 'FEATURE_GATED' },
      });
      await expect(postsService.getActiveResearch()).resolves.toEqual({ active: false });
    });

    it('returns inactive when the request throws', async () => {
      mockMakeRequest.mockRejectedValue(new Error('network'));
      await expect(postsService.getActiveResearch()).resolves.toEqual({ active: false });
    });
  });

  describe('cancelResearch', () => {
    it('calls the cancel_research op with the job id', async () => {
      mockSendLLMRequest.mockResolvedValue({ success: true, data: { success: true } });
      await postsService.cancelResearch('job-x');
      expect(mockSendLLMRequest).toHaveBeenCalledWith('cancel_research', { job_id: 'job-x' });
    });

    it('throws when the cancel request fails', async () => {
      mockSendLLMRequest.mockResolvedValue({ success: false, error: 'nope' });
      await expect(postsService.cancelResearch('job-x')).rejects.toThrow('nope');
    });

    it('throws when the backend body reports failure at HTTP 200', async () => {
      // Transport says success (HTTP 200) but the lambda body says it failed.
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { success: false, error: 'Research job not found' },
      });
      await expect(postsService.cancelResearch('job-x')).rejects.toThrow('Research job not found');
    });
  });

  describe('synthesizeResearch', () => {
    it('should return synthesized content on success', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { content: 'Synthesized post content' },
      });

      const result = await postsService.synthesizeResearch(
        { existing_content: 'draft', research_content: 'research data', selected_ideas: ['idea1'] },
        mockProfile
      );

      expect(result).toEqual({ content: 'Synthesized post content' });
      expect(mockSendLLMRequest).toHaveBeenCalledWith(
        'synthesize_research',
        expect.objectContaining({
          existing_content: 'draft',
          research_content: 'research data',
          selected_ideas: ['idea1'],
          job_id: 'test-uuid-1234',
        })
      );
    });

    it('should throw on API failure', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: false,
        error: 'Synthesis failed',
      });

      await expect(postsService.synthesizeResearch({ existing_content: 'draft' })).rejects.toThrow(
        'Synthesis failed'
      );
    });

    it('should throw when no content returned', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { content: '' },
      });

      await expect(postsService.synthesizeResearch({ existing_content: 'draft' })).rejects.toThrow(
        'No synthesis result returned'
      );
    });

    it('should sanitize profile before sending', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { content: 'result' },
      });

      await postsService.synthesizeResearch({ existing_content: 'draft' }, mockProfile);

      const sentProfile = mockSendLLMRequest.mock.calls[0][1].user_profile;
      expect(sentProfile).not.toHaveProperty('linkedin_credentials');
      expect(sentProfile).not.toHaveProperty('ai_generated_ideas');
    });

    it('should handle null research_content', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { content: 'result' },
      });

      await postsService.synthesizeResearch({ existing_content: 'draft' });

      expect(mockSendLLMRequest.mock.calls[0][1].research_content).toBeNull();
    });
  });

  describe('response schema validation', () => {
    it('strips unknown fields injected by the server (no PII leak)', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: {
          ideas: ['a', 'b'],
          // Anything not in the schema gets dropped — even if the server
          // accidentally adds it, callers cannot depend on it.
          internal_user_notes: 'leaked PII',
        },
        legacy_field: 'old',
      });

      const ideas = await postsService.generateIdeas('x');
      expect(ideas).toEqual(['a', 'b']);
    });

    it('throws a schema error when success field is the wrong type', async () => {
      mockSendLLMRequest.mockResolvedValue({
        // success should be boolean; sending a number forces zod to fail.
        success: 1,
        data: { ideas: ['a'] },
      });

      await expect(postsService.generateIdeas('x')).rejects.toThrow();
    });

    it('parses research polling response with extra fields stripped', async () => {
      mockSendLLMRequest.mockResolvedValue({
        success: true,
        data: { job_id: 'job-789' },
      });
      mockMakeRequest.mockResolvedValue({
        success: true,
        data: { content: 'result', hidden_token: 'shhh' },
      });

      vi.useFakeTimers();
      const promise = postsService.researchTopics(['topic']);
      await vi.advanceTimersByTimeAsync(15_000);
      const res = await promise;
      vi.useRealTimers();

      expect(res).toBe('result');
      // The poll call carries a correlation_id for traceability.
      const pollParams = mockMakeRequest.mock.calls[0]?.[2];
      expect(pollParams).toHaveProperty('correlation_id');
    });
  });
});
