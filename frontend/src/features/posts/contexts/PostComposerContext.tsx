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
import { profileApiService } from '@/shared/services/profileApiService';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('PostComposer');

interface PostComposerContextValue {
  isGeneratingIdeas: boolean;
  isResearching: boolean;
  isSynthesizing: boolean;
  ideas: string[];
  selectedIdeas: string[];
  updateSelectedIdeas: (ideas: string[]) => void;
  researchContent: string | null;
  includeResearch: boolean;
  setIncludeResearch: (next: boolean) => void;
  synthesizedPost: string | null;
  generateIdeas: (prompt?: string) => Promise<string[]>;
  researchTopics: (topics: string[]) => Promise<void>;
  synthesizeResearch: () => Promise<void>;
  clearResearch: () => Promise<void>;
  clearIdea: (newIdeas: string[]) => Promise<void>;
  clearSynthesizedPost: () => Promise<void>;
}

const PostComposerContext = createContext<PostComposerContextValue | undefined>(undefined);

export const usePostComposer = (): PostComposerContextValue => {
  const ctx = useContext(PostComposerContext);
  if (!ctx) throw new Error('usePostComposer must be used within PostComposerProvider');
  return ctx;
};

export const PostComposerProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const { userProfile, refreshUserProfile } = useUserProfile();
  const [isGeneratingIdeas, setIsGeneratingIdeas] = useState(false);
  const [isResearching, setIsResearching] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [selectedIdeas, setSelectedIdeas] = useState<string[]>([]);
  const [includeResearch, setIncludeResearch] = useState(true);

  // All composer state derives from userProfile (DynamoDB single source of
  // truth). The backend writes ai_generated_ideas / ai_generated_research /
  // ai_synthesized_post on each LLM completion and clears them at handler
  // entry; the frontend just reads.
  const ideas = useMemo<string[]>(() => {
    const fromProfile = (userProfile as { ai_generated_ideas?: unknown } | null)
      ?.ai_generated_ideas;
    return Array.isArray(fromProfile) ? (fromProfile as string[]) : [];
  }, [userProfile]);

  const researchContent = useMemo<string | null>(() => {
    const value = (userProfile as { ai_generated_research?: unknown } | null)
      ?.ai_generated_research;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }, [userProfile]);

  const synthesizedPost = useMemo<string | null>(() => {
    const value = (userProfile as { ai_synthesized_post?: unknown } | null)?.ai_synthesized_post;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }, [userProfile]);

  // Drop ephemeral selection state when the user signs out.
  useEffect(() => {
    if (!user || !userProfile) setSelectedIdeas([]);
  }, [user, userProfile]);

  // Reset include-research to true whenever fresh research arrives so the
  // user opts in by default, then can opt out per synthesis.
  useEffect(() => {
    if (researchContent) setIncludeResearch(true);
  }, [researchContent]);

  const generateIdeas = useCallback(
    async (prompt?: string): Promise<string[]> => {
      setIsGeneratingIdeas(true);
      try {
        const result = await postsService.generateIdeas(prompt, userProfile || undefined);
        // Backend has already written ai_generated_ideas on the profile;
        // refresh is best-effort to pull the canonical state into the UI.
        // A transient refresh failure must NOT poison the mutation —
        // otherwise the user sees an apparent failure and retries,
        // triggering a fresh LLM call that overwrites the correct
        // DynamoDB state. Mutation success is determined by postsService.
        refreshUserProfile().catch((err) => {
          logger.warn('profile refresh after generateIdeas failed', { error: err });
        });
        return result;
      } finally {
        setIsGeneratingIdeas(false);
      }
    },
    [userProfile, refreshUserProfile]
  );

  const researchTopics = useCallback(
    async (topics: string[]) => {
      setIsResearching(true);
      try {
        await postsService.researchTopics(topics, userProfile || undefined);
        // Fire-and-forget refresh — see generateIdeas for rationale.
        refreshUserProfile().catch((err) => {
          logger.warn('profile refresh after researchTopics failed', { error: err });
        });
      } finally {
        setIsResearching(false);
      }
    },
    [userProfile, refreshUserProfile]
  );

  const updateSelectedIdeas = useCallback((next: string[]) => {
    setSelectedIdeas(next);
  }, []);

  const synthesizeResearch = useCallback(async () => {
    const ideasForSynthesis = selectedIdeas.length > 0 ? selectedIdeas : undefined;
    const researchForSynthesis = includeResearch ? (researchContent ?? undefined) : undefined;
    logger.debug('synthesize: start', {
      hasResearch: !!researchForSynthesis,
      includeResearch,
      ideasCount: ideasForSynthesis?.length || 0,
    });
    setIsSynthesizing(true);
    try {
      await postsService.synthesizeResearch(
        {
          existing_content: '',
          research_content: researchForSynthesis,
          selected_ideas: ideasForSynthesis,
        },
        userProfile || undefined
      );
      // Fire-and-forget refresh — see generateIdeas for rationale.
      refreshUserProfile().catch((err) => {
        logger.warn('profile refresh after synthesizeResearch failed', { error: err });
      });
    } finally {
      setIsSynthesizing(false);
    }
  }, [researchContent, includeResearch, selectedIdeas, userProfile, refreshUserProfile]);

  // The clear helpers are the inverse of the generate/research/synthesize
  // flows: there's no upstream side-effect to protect — the API call IS
  // the operation. If updateUserProfile fails, the data is still on the
  // user's profile, so callers must see the error and surface it (toast
  // / retry prompt). We log + re-throw so callers' try/catch receives
  // it. The follow-up refreshUserProfile is fire-and-forget for the
  // same reason as the generate flows: a transient refresh failure
  // shouldn't make a successful clear look failed.
  const clearResearch = useCallback(async () => {
    try {
      await profileApiService.updateUserProfile({ ai_generated_research: '' });
    } catch (error) {
      logger.error('Failed to clear research from profile', { error });
      throw error;
    }
    refreshUserProfile().catch((err) => {
      logger.warn('profile refresh after clearResearch failed', { error: err });
    });
  }, [refreshUserProfile]);

  const clearIdea = useCallback(
    async (newIdeas: string[]) => {
      try {
        await profileApiService.updateUserProfile({ ai_generated_ideas: newIdeas });
      } catch (error) {
        logger.error('Failed to update ideas in profile', { error });
        throw error;
      }
      // Drop any selections that no longer exist in the new list.
      setSelectedIdeas((prev) => prev.filter((s) => newIdeas.includes(s)));
      refreshUserProfile().catch((err) => {
        logger.warn('profile refresh after clearIdea failed', { error: err });
      });
    },
    [refreshUserProfile]
  );

  const clearSynthesizedPost = useCallback(async () => {
    try {
      await profileApiService.updateUserProfile({ ai_synthesized_post: '' });
    } catch (error) {
      logger.error('Failed to clear synthesized post from profile', { error });
      throw error;
    }
    refreshUserProfile().catch((err) => {
      logger.warn('profile refresh after clearSynthesizedPost failed', { error: err });
    });
  }, [refreshUserProfile]);

  const value = useMemo(
    () => ({
      isGeneratingIdeas,
      isResearching,
      isSynthesizing,
      ideas,
      selectedIdeas,
      updateSelectedIdeas,
      researchContent,
      includeResearch,
      setIncludeResearch,
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
      selectedIdeas,
      updateSelectedIdeas,
      researchContent,
      includeResearch,
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
