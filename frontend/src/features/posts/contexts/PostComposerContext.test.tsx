import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const {
  mockGenerateIdeas,
  mockResearchTopics,
  mockSynthesizeResearch,
  mockUpdateUserProfile,
  mockRefreshUserProfile,
  mockUser,
  mockUserProfile,
} = vi.hoisted(() => ({
  mockGenerateIdeas: vi.fn(),
  mockResearchTopics: vi.fn(),
  mockSynthesizeResearch: vi.fn(),
  mockUpdateUserProfile: vi.fn(),
  mockRefreshUserProfile: vi.fn(),
  mockUser: {
    value: { id: 'user-1', email: 'test@example.com' } as Record<string, unknown> | null,
  },
  mockUserProfile: { value: { firstName: 'John' } as Record<string, unknown> | null },
}));

vi.mock('@/features/posts', () => ({
  postsService: {
    generateIdeas: mockGenerateIdeas,
    researchTopics: mockResearchTopics,
    synthesizeResearch: mockSynthesizeResearch,
  },
}));

vi.mock('@/features/auth', () => ({
  useAuth: () => ({ user: mockUser.value }),
}));

vi.mock('@/features/profile', () => ({
  useUserProfile: () => ({
    userProfile: mockUserProfile.value,
    refreshUserProfile: mockRefreshUserProfile,
  }),
}));

vi.mock('@/shared/services/profileApiService', () => ({
  profileApiService: {
    updateUserProfile: mockUpdateUserProfile,
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { PostComposerProvider, usePostComposer } from './PostComposerContext';

function createWrapper() {
  return ({ children }: { children: ReactNode }) => (
    <PostComposerProvider>{children}</PostComposerProvider>
  );
}

describe('PostComposerContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.value = { id: 'user-1', email: 'test@example.com' };
    mockUserProfile.value = { firstName: 'John' };
    mockUpdateUserProfile.mockResolvedValue({ success: true });
    mockRefreshUserProfile.mockResolvedValue(undefined);
  });

  it('throws when used outside provider', () => {
    const orig = console.error;
    console.error = vi.fn();
    expect(() => renderHook(() => usePostComposer())).toThrow(
      'usePostComposer must be used within PostComposerProvider'
    );
    console.error = orig;
  });

  describe('hydration from userProfile', () => {
    it('exposes ideas from profile.ai_generated_ideas', () => {
      mockUserProfile.value = {
        firstName: 'John',
        ai_generated_ideas: ['Idea 1', 'Idea 2'],
      };
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });
      expect(result.current.ideas).toEqual(['Idea 1', 'Idea 2']);
    });

    it('exposes research from profile.ai_generated_research', () => {
      mockUserProfile.value = {
        firstName: 'John',
        ai_generated_research: 'stored research',
      };
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });
      expect(result.current.researchContent).toBe('stored research');
    });

    it('exposes synthesizedPost from profile.ai_synthesized_post', () => {
      mockUserProfile.value = {
        firstName: 'John',
        ai_synthesized_post: 'stored post',
      };
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });
      expect(result.current.synthesizedPost).toBe('stored post');
    });

    it('returns empty defaults when profile fields are absent', () => {
      mockUserProfile.value = { firstName: 'John' };
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });
      expect(result.current.ideas).toEqual([]);
      expect(result.current.researchContent).toBeNull();
      expect(result.current.synthesizedPost).toBeNull();
    });

    it('treats empty-string research/synthesized as cleared', () => {
      mockUserProfile.value = {
        firstName: 'John',
        ai_generated_research: '',
        ai_synthesized_post: '',
      };
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });
      expect(result.current.researchContent).toBeNull();
      expect(result.current.synthesizedPost).toBeNull();
    });

    it('clears selectedIdeas when user signs out', async () => {
      const { result, rerender } = renderHook(() => usePostComposer(), {
        wrapper: createWrapper(),
      });
      act(() => result.current.updateSelectedIdeas(['Idea A']));
      expect(result.current.selectedIdeas).toEqual(['Idea A']);

      mockUser.value = null;
      mockUserProfile.value = null;
      rerender();
      await waitFor(() => expect(result.current.selectedIdeas).toEqual([]));
    });
  });

  describe('LLM operations refresh profile from backend', () => {
    it('generateIdeas calls postsService and refreshes profile', async () => {
      mockGenerateIdeas.mockResolvedValue(['New 1', 'New 2']);
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.generateIdeas('topic');
      });

      expect(mockGenerateIdeas).toHaveBeenCalledWith('topic', { firstName: 'John' });
      expect(mockRefreshUserProfile).toHaveBeenCalledTimes(1);
    });

    it('researchTopics calls postsService and refreshes profile', async () => {
      mockResearchTopics.mockResolvedValue('research blob');
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.researchTopics(['t1']);
      });

      expect(mockResearchTopics).toHaveBeenCalledWith(['t1'], { firstName: 'John' });
      expect(mockRefreshUserProfile).toHaveBeenCalledTimes(1);
    });

    it('synthesizeResearch calls postsService and refreshes profile', async () => {
      mockUserProfile.value = {
        firstName: 'John',
        ai_generated_research: 'research',
      };
      mockSynthesizeResearch.mockResolvedValue({ content: 'synthesized!' });
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      act(() => result.current.updateSelectedIdeas(['Idea 1']));

      await act(async () => {
        await result.current.synthesizeResearch();
      });

      expect(mockSynthesizeResearch).toHaveBeenCalledWith(
        {
          existing_content: '',
          research_content: 'research',
          selected_ideas: ['Idea 1'],
        },
        { firstName: 'John', ai_generated_research: 'research' }
      );
      expect(mockRefreshUserProfile).toHaveBeenCalledTimes(1);
    });

    it('synthesizeResearch omits research_content when includeResearch=false', async () => {
      mockUserProfile.value = {
        firstName: 'John',
        ai_generated_research: 'research',
      };
      mockSynthesizeResearch.mockResolvedValue({ content: 'synthesized!' });
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      act(() => result.current.updateSelectedIdeas(['Idea 1']));
      act(() => result.current.setIncludeResearch(false));

      await act(async () => {
        await result.current.synthesizeResearch();
      });

      const payload = mockSynthesizeResearch.mock.calls[0][0] as {
        research_content?: unknown;
      };
      expect(payload.research_content).toBeUndefined();
    });

    it('includeResearch resets to true when fresh research arrives', async () => {
      mockUserProfile.value = { firstName: 'John' };
      const { result, rerender } = renderHook(() => usePostComposer(), {
        wrapper: createWrapper(),
      });
      expect(result.current.includeResearch).toBe(true);

      act(() => result.current.setIncludeResearch(false));
      expect(result.current.includeResearch).toBe(false);

      mockUserProfile.value = {
        firstName: 'John',
        ai_generated_research: 'fresh research',
      };
      rerender();
      await waitFor(() => expect(result.current.includeResearch).toBe(true));
    });
  });

  describe('clear actions write empty value to profile', () => {
    it('clearResearch writes empty string and refreshes', async () => {
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.clearResearch();
      });

      expect(mockUpdateUserProfile).toHaveBeenCalledWith({ ai_generated_research: '' });
      expect(mockRefreshUserProfile).toHaveBeenCalledTimes(1);
    });

    it('clearIdea writes new ideas list and refreshes', async () => {
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.clearIdea(['Kept idea']);
      });

      expect(mockUpdateUserProfile).toHaveBeenCalledWith({ ai_generated_ideas: ['Kept idea'] });
      expect(mockRefreshUserProfile).toHaveBeenCalledTimes(1);
    });

    it('clearSynthesizedPost writes empty string and refreshes', async () => {
      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.clearSynthesizedPost();
      });

      expect(mockUpdateUserProfile).toHaveBeenCalledWith({ ai_synthesized_post: '' });
      expect(mockRefreshUserProfile).toHaveBeenCalledTimes(1);
    });
  });
});
