import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const {
  mockGenerateIdeas,
  mockResearchTopics,
  mockSynthesizeResearch,
  mockUpdateUserProfile,
  mockUser,
  mockUserProfile,
} = vi.hoisted(() => ({
  mockGenerateIdeas: vi.fn(),
  mockResearchTopics: vi.fn(),
  mockSynthesizeResearch: vi.fn(),
  mockUpdateUserProfile: vi.fn(),
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
  useUserProfile: () => ({ userProfile: mockUserProfile.value }),
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
    sessionStorage.clear();
    mockUser.value = { id: 'user-1', email: 'test@example.com' };
    mockUserProfile.value = { firstName: 'John' };
  });

  it('should throw when used outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => usePostComposer())).toThrow(
      'usePostComposer must be used within PostComposerProvider'
    );
    spy.mockRestore();
  });

  it('should initialize with empty state', () => {
    const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

    expect(result.current.ideas).toEqual([]);
    expect(result.current.selectedIdeas).toEqual([]);
    expect(result.current.researchContent).toBeNull();
    expect(result.current.synthesizedPost).toBeNull();
    expect(result.current.isGeneratingIdeas).toBe(false);
    expect(result.current.isResearching).toBe(false);
    expect(result.current.isSynthesizing).toBe(false);
  });

  describe('sessionStorage hydration', () => {
    it('should hydrate ideas from sessionStorage', () => {
      sessionStorage.setItem('ai_generated_ideas', JSON.stringify(['Idea 1', 'Idea 2']));

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      expect(result.current.ideas).toEqual(['Idea 1', 'Idea 2']);
    });

    it('should hydrate research from sessionStorage', () => {
      sessionStorage.setItem('ai_research_content', JSON.stringify('stored research'));

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      expect(result.current.researchContent).toBe('stored research');
    });

    it('should hydrate synthesized post from sessionStorage', () => {
      sessionStorage.setItem('ai_synthesized_post', 'stored post');

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      expect(result.current.synthesizedPost).toBe('stored post');
    });

    it('should hydrate selected ideas from sessionStorage', () => {
      sessionStorage.setItem('ai_selected_ideas', JSON.stringify(['sel1']));

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      expect(result.current.selectedIdeas).toEqual(['sel1']);
    });
  });

  describe('state clears when user logs out', () => {
    it('should clear all state when user becomes null', async () => {
      sessionStorage.setItem('ai_generated_ideas', JSON.stringify(['Idea']));
      sessionStorage.setItem('ai_research_content', JSON.stringify('research'));
      sessionStorage.setItem('ai_synthesized_post', 'post');

      const { result, rerender } = renderHook(() => usePostComposer(), {
        wrapper: createWrapper(),
      });

      expect(result.current.ideas).toEqual(['Idea']);

      // Simulate logout
      mockUser.value = null;
      rerender();

      await waitFor(() => {
        expect(result.current.ideas).toEqual([]);
      });
      expect(result.current.researchContent).toBeNull();
      expect(result.current.synthesizedPost).toBeNull();
    });
  });

  describe('generateIdeas', () => {
    it('should call postsService and update state', async () => {
      mockGenerateIdeas.mockResolvedValue(['New Idea 1', 'New Idea 2']);

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      let ideas: string[];
      await act(async () => {
        ideas = await result.current.generateIdeas('tech leadership');
      });

      expect(ideas!).toEqual(['New Idea 1', 'New Idea 2']);
      expect(result.current.ideas).toEqual(['New Idea 1', 'New Idea 2']);
      expect(result.current.isGeneratingIdeas).toBe(false);
      expect(sessionStorage.getItem('ai_generated_ideas')).toBe(
        JSON.stringify(['New Idea 1', 'New Idea 2'])
      );
    });

    it('should set loading state during generation', async () => {
      let resolveGenerate: (v: string[]) => void;
      mockGenerateIdeas.mockReturnValue(
        new Promise<string[]>((resolve) => {
          resolveGenerate = resolve;
        })
      );

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      let promise: Promise<string[]>;
      act(() => {
        promise = result.current.generateIdeas();
      });

      expect(result.current.isGeneratingIdeas).toBe(true);

      await act(async () => {
        resolveGenerate!(['idea']);
        await promise!;
      });

      expect(result.current.isGeneratingIdeas).toBe(false);
    });
  });

  describe('researchTopics', () => {
    it('should call postsService and update state', async () => {
      mockResearchTopics.mockResolvedValue('Research results');

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.researchTopics(['topic1']);
      });

      expect(result.current.researchContent).toBe('Research results');
      expect(result.current.isResearching).toBe(false);
      expect(sessionStorage.getItem('ai_research_content')).toBe(
        JSON.stringify('Research results')
      );
    });
  });

  describe('synthesizeResearch', () => {
    it('should call postsService with selectedIdeas', async () => {
      mockSynthesizeResearch.mockResolvedValue({ content: 'Synthesized post' });

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      // Set up selected ideas first
      act(() => {
        result.current.updateSelectedIdeas(['idea1', 'idea2']);
      });

      await act(async () => {
        await result.current.synthesizeResearch();
      });

      expect(result.current.synthesizedPost).toBe('Synthesized post');
      expect(mockSynthesizeResearch).toHaveBeenCalledWith(
        expect.objectContaining({ selected_ideas: ['idea1', 'idea2'] }),
        expect.anything()
      );
    });

    it('should pass undefined ideas when none selected', async () => {
      mockSynthesizeResearch.mockResolvedValue({ content: 'result' });

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.synthesizeResearch();
      });

      expect(mockSynthesizeResearch).toHaveBeenCalledWith(
        expect.objectContaining({ selected_ideas: undefined }),
        expect.anything()
      );
    });
  });

  describe('clearResearch', () => {
    it('should clear research content and sessionStorage', async () => {
      mockResearchTopics.mockResolvedValue('Research');
      mockUpdateUserProfile.mockResolvedValue({});

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.researchTopics(['topic']);
      });
      expect(result.current.researchContent).toBe('Research');

      await act(async () => {
        await result.current.clearResearch();
      });

      expect(result.current.researchContent).toBeNull();
      expect(sessionStorage.getItem('ai_research_content')).toBeNull();
      expect(mockUpdateUserProfile).toHaveBeenCalledWith({ ai_generated_research: '' });
    });
  });

  describe('clearSynthesizedPost', () => {
    it('should clear synthesized post and sessionStorage', async () => {
      mockSynthesizeResearch.mockResolvedValue({ content: 'post' });

      const { result } = renderHook(() => usePostComposer(), { wrapper: createWrapper() });

      await act(async () => {
        await result.current.synthesizeResearch();
      });
      expect(result.current.synthesizedPost).toBe('post');

      act(() => {
        result.current.clearSynthesizedPost();
      });

      expect(result.current.synthesizedPost).toBeNull();
      expect(sessionStorage.getItem('ai_synthesized_post')).toBeNull();
    });
  });
});
