import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserProfile } from '@/types';

const { mockSendLLMRequest, mockCallProfilesOperation } = vi.hoisted(() => ({
  mockSendLLMRequest: vi.fn(),
  mockCallProfilesOperation: vi.fn(),
}));

vi.mock('@/shared/services/analyticsApiService', () => ({
  analyticsApiService: {
    sendLLMRequest: mockSendLLMRequest,
    callProfilesOperation: mockCallProfilesOperation,
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
      mockCallProfilesOperation.mockResolvedValue({
        success: true,
        content: 'Deep research results about AI trends',
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
      mockCallProfilesOperation.mockResolvedValue({
        success: true,
        content: 'results',
      });

      vi.useFakeTimers();
      const promise = postsService.researchTopics(['topic'], mockProfile);
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;
      vi.useRealTimers();

      const sentProfile = mockSendLLMRequest.mock.calls[0][1].user_profile;
      expect(sentProfile).not.toHaveProperty('linkedin_credentials');
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
});
