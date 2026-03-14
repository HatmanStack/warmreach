import {
  createContext,
  useContext,
  type ReactNode,
  useState,
  useCallback,
  useMemo,
  useEffect,
} from 'react';
import { postsService } from '@/features/posts';
import { useAuth } from '@/features/auth';
import { useUserProfile } from '@/features/profile';
import { lambdaApiService } from '@/shared/services';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('PostComposer');

const IDEAS_STORAGE_KEY = 'ai_generated_ideas';
const RESEARCH_STORAGE_KEY = 'ai_research_content';
const SYNTHESIZED_STORAGE_KEY = 'ai_synthesized_post';
const SELECTED_IDEAS_STORAGE_KEY = 'ai_selected_ideas';

interface PostComposerContextValue {
  isGeneratingIdeas: boolean;
  isResearching: boolean;
  isSynthesizing: boolean;
  ideas: string[];
  updateIdeas: (ideas: string[]) => void;
  selectedIdeas: string[];
  updateSelectedIdeas: (ideas: string[]) => void;
  researchContent: string | null;
  synthesizedPost: string | null;
  generateIdeas: (prompt?: string) => Promise<string[]>;
  researchTopics: (topics: string[]) => Promise<void>;
  synthesizeResearch: () => Promise<void>;
  clearResearch: () => Promise<void>;
  clearIdea: (newIdeas: string[]) => Promise<void>;
  clearSynthesizedPost: () => void;
}

const PostComposerContext = createContext<PostComposerContextValue | undefined>(undefined);

export const usePostComposer = (): PostComposerContextValue => {
  const ctx = useContext(PostComposerContext);
  if (!ctx) throw new Error('usePostComposer must be used within PostComposerProvider');
  return ctx;
};

export const PostComposerProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const { userProfile } = useUserProfile();
  const [isGeneratingIdeas, setIsGeneratingIdeas] = useState(false);
  const [isResearching, setIsResearching] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [ideas, setIdeas] = useState<string[]>([]);
  const [selectedIdeas, setSelectedIdeas] = useState<string[]>([]);
  const [researchContent, setResearchContent] = useState<string | null>(null);
  const [synthesizedPost, setSynthesizedPost] = useState<string | null>(null);

  // Hydrate from session storage on mount
  useEffect(() => {
    if (!user || !userProfile) {
      setIdeas([]);
      setSelectedIdeas([]);
      setResearchContent(null);
      setSynthesizedPost(null);
      try {
        sessionStorage.removeItem(IDEAS_STORAGE_KEY);
        sessionStorage.removeItem(SELECTED_IDEAS_STORAGE_KEY);
        sessionStorage.removeItem(RESEARCH_STORAGE_KEY);
        sessionStorage.removeItem(SYNTHESIZED_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      const storedIdeas = sessionStorage.getItem(IDEAS_STORAGE_KEY);
      if (storedIdeas) {
        setIdeas(JSON.parse(storedIdeas));
      } else {
        const fromProfile = (userProfile as Record<string, unknown>).ai_generated_ideas as
          | string[]
          | undefined;
        if (Array.isArray(fromProfile)) setIdeas(fromProfile);
      }
    } catch {
      /* ignore */
    }

    try {
      const storedResearch = sessionStorage.getItem(RESEARCH_STORAGE_KEY);
      if (storedResearch) setResearchContent(JSON.parse(storedResearch));
    } catch {
      /* ignore */
    }

    try {
      const storedPost = sessionStorage.getItem(SYNTHESIZED_STORAGE_KEY);
      if (storedPost) setSynthesizedPost(storedPost);
    } catch {
      /* ignore */
    }

    try {
      const storedSelected = sessionStorage.getItem(SELECTED_IDEAS_STORAGE_KEY);
      if (storedSelected) {
        const parsed = JSON.parse(storedSelected);
        if (Array.isArray(parsed)) setSelectedIdeas(parsed);
      }
    } catch {
      /* ignore */
    }
  }, [user, userProfile]);

  const generateIdeas = useCallback(
    async (prompt?: string): Promise<string[]> => {
      setIsGeneratingIdeas(true);
      try {
        const result = await postsService.generateIdeas(prompt, userProfile || undefined);
        setIdeas(result);
        try {
          sessionStorage.setItem(IDEAS_STORAGE_KEY, JSON.stringify(result));
        } catch {
          /* ignore */
        }
        return result;
      } finally {
        setIsGeneratingIdeas(false);
      }
    },
    [userProfile]
  );

  const researchTopics = useCallback(
    async (topics: string[]) => {
      setIsResearching(true);
      try {
        const result = await postsService.researchTopics(topics, userProfile || undefined);
        if (result) {
          setResearchContent(result);
          try {
            sessionStorage.setItem(RESEARCH_STORAGE_KEY, JSON.stringify(result));
          } catch {
            /* ignore */
          }
        } else {
          setResearchContent(null);
          try {
            sessionStorage.removeItem(RESEARCH_STORAGE_KEY);
          } catch {
            /* ignore */
          }
        }
      } finally {
        setIsResearching(false);
      }
    },
    [userProfile]
  );

  const updateSelectedIdeas = useCallback((ideas: string[]) => {
    setSelectedIdeas(ideas);
    try {
      sessionStorage.setItem(SELECTED_IDEAS_STORAGE_KEY, JSON.stringify(ideas));
    } catch {
      /* ignore */
    }
  }, []);

  const synthesizeResearch = useCallback(async () => {
    const ideasForSynthesis = selectedIdeas.length > 0 ? selectedIdeas : undefined;
    logger.debug('synthesize: start', {
      hasResearch: !!researchContent,
      ideasCount: ideasForSynthesis?.length || 0,
    });
    setIsSynthesizing(true);
    try {
      const synthesized = await postsService.synthesizeResearch(
        {
          existing_content: '',
          research_content: researchContent ?? undefined,
          selected_ideas: ideasForSynthesis,
        },
        userProfile || undefined
      );
      if (synthesized?.content) {
        setSynthesizedPost(synthesized.content);
        try {
          sessionStorage.setItem(SYNTHESIZED_STORAGE_KEY, synthesized.content);
        } catch {
          /* ignore */
        }
      }
    } finally {
      setIsSynthesizing(false);
    }
  }, [researchContent, selectedIdeas, userProfile]);

  const clearResearch = useCallback(async () => {
    setResearchContent(null);
    try {
      sessionStorage.removeItem(RESEARCH_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    try {
      await lambdaApiService.updateUserProfile({ ai_generated_research: '' });
    } catch (error) {
      logger.error('Failed to clear research from profile', { error });
    }
  }, []);

  const clearIdea = useCallback(async (newIdeas: string[]) => {
    setIdeas(newIdeas);
    try {
      sessionStorage.setItem(IDEAS_STORAGE_KEY, JSON.stringify(newIdeas));
    } catch {
      /* ignore */
    }
    try {
      await lambdaApiService.updateUserProfile({ ai_generated_ideas: newIdeas });
    } catch (error) {
      logger.error('Failed to update ideas in profile', { error });
    }
  }, []);

  const clearSynthesizedPost = useCallback(() => {
    setSynthesizedPost(null);
    try {
      sessionStorage.removeItem(SYNTHESIZED_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const updateIdeas = useCallback((newIdeas: string[]) => {
    setIdeas(newIdeas);
    try {
      sessionStorage.setItem(IDEAS_STORAGE_KEY, JSON.stringify(newIdeas));
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({
      isGeneratingIdeas,
      isResearching,
      isSynthesizing,
      ideas,
      updateIdeas,
      selectedIdeas,
      updateSelectedIdeas,
      researchContent,
      synthesizedPost,
      generateIdeas,
      researchTopics,
      synthesizeResearch,
      clearResearch,
      clearIdea,
      clearSynthesizedPost,
    }),
    [
      isGeneratingIdeas,
      isResearching,
      isSynthesizing,
      ideas,
      updateIdeas,
      selectedIdeas,
      updateSelectedIdeas,
      researchContent,
      synthesizedPost,
      generateIdeas,
      researchTopics,
      synthesizeResearch,
      clearResearch,
      clearIdea,
      clearSynthesizedPost,
    ]
  );

  return <PostComposerContext.Provider value={value}>{children}</PostComposerContext.Provider>;
};
