import {
  createContext,
  useContext,
  type ReactNode,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
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
  cancelResearch: () => Promise<void>;
  researchingIdeas: string[];
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
  // Topics of the in-flight research job, for the "Researching…" indicator.
  const [researchingIdeas, setResearchingIdeas] = useState<string[]>([]);

  // Refs backing the in-flight deep-research poll: the AbortController lets
  // Cancel/unmount interrupt the long poll, and the job_id lets cancelResearch
  // target the right job. Refs (not state) so they don't re-trigger renders or
  // the resume effect mid-poll. resumeCheckedRef fires the resume-on-load check
  // exactly once per session.
  const researchAbortRef = useRef<AbortController | null>(null);
  const activeResearchJobIdRef = useRef<string | null>(null);
  const resumeCheckedRef = useRef(false);

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

  // Drop ephemeral selection state when the user signs out, abort any in-flight
  // research poll, and re-arm the resume-on-load check for the next login.
  useEffect(() => {
    if (!user || !userProfile) setSelectedIdeas([]);
    if (!user) {
      resumeCheckedRef.current = false;
      researchAbortRef.current?.abort();
    }
  }, [user, userProfile]);

  // Reset include-research to true whenever fresh research arrives so the
  // user opts in by default, then can opt out per synthesis.
  useEffect(() => {
    if (researchContent) setIncludeResearch(true);
  }, [researchContent]);

  // Resume-on-load: after a refresh the browser has lost the in-flight job_id,
  // so ask the backend for any active research job and resume polling it. The
  // backend also reconciles the job against OpenAI, so a job that completed
  // while nobody was polling gets surfaced here too. Runs once per session.
  useEffect(() => {
    if (!user || !userProfile) return;
    if (resumeCheckedRef.current) return;
    resumeCheckedRef.current = true;

    let disposed = false;
    (async () => {
      try {
        const active = await postsService.getActiveResearch();
        if (disposed) return;

        if (active.content) {
          // Completed while nobody was polling; the backend just mirrored it to
          // the profile — pull it into the UI.
          refreshUserProfile().catch((err) => {
            logger.warn('profile refresh after resume-complete failed', { error: err });
          });
          return;
        }

        if (active.active && active.jobId) {
          // Abort any poll already in flight before taking over the ref.
          researchAbortRef.current?.abort();
          const controller = new AbortController();
          researchAbortRef.current = controller;
          activeResearchJobIdRef.current = active.jobId;
          setResearchingIdeas(active.selectedIdeas ?? []);
          setIsResearching(true);
          try {
            await postsService.pollResearchResult(active.jobId, { signal: controller.signal });
            refreshUserProfile().catch((err) => {
              logger.warn('profile refresh after resumed research failed', { error: err });
            });
          } catch (err) {
            if (!(err instanceof Error && err.name === 'AbortError')) {
              logger.warn('resumed research poll failed', { error: err });
            }
          } finally {
            // Only clean up if a newer research didn't take over the refs.
            if (researchAbortRef.current === controller) {
              setIsResearching(false);
              setResearchingIdeas([]);
              researchAbortRef.current = null;
              activeResearchJobIdRef.current = null;
            }
          }
        }
      } catch (err) {
        logger.warn('resume-on-load research check failed', { error: err });
      }
    })();

    return () => {
      disposed = true;
    };
    // refreshUserProfile is intentionally omitted — it isn't memoized and the
    // resumeCheckedRef guard already limits this to once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, userProfile]);

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
      // Abort any still-running poll (e.g. a resume-on-load poll) before taking
      // over the ref, so its controller isn't orphaned.
      researchAbortRef.current?.abort();
      const controller = new AbortController();
      researchAbortRef.current = controller;
      setResearchingIdeas(topics);
      setIsResearching(true);
      try {
        await postsService.researchTopics(topics, userProfile || undefined, {
          signal: controller.signal,
          onJobId: (id) => {
            activeResearchJobIdRef.current = id;
          },
        });
        // Fire-and-forget refresh — see generateIdeas for rationale.
        refreshUserProfile().catch((err) => {
          logger.warn('profile refresh after researchTopics failed', { error: err });
        });
      } catch (err) {
        // Cancel/unmount aborts the poll — expected, not a failure.
        if (!(err instanceof Error && err.name === 'AbortError')) {
          logger.warn('researchTopics failed', { error: err });
        }
      } finally {
        // Only clean up if a newer research didn't take over the refs.
        if (researchAbortRef.current === controller) {
          setIsResearching(false);
          setResearchingIdeas([]);
          researchAbortRef.current = null;
          activeResearchJobIdRef.current = null;
        }
      }
    },
    [userProfile, refreshUserProfile]
  );

  const cancelResearch = useCallback(async () => {
    const jobId = activeResearchJobIdRef.current;
    // Stop the local poll and clear the indicator immediately. Clear the refs
    // BEFORE the network round-trip so a research started during it isn't
    // clobbered when this resolves.
    researchAbortRef.current?.abort();
    researchAbortRef.current = null;
    activeResearchJobIdRef.current = null;
    setIsResearching(false);
    setResearchingIdeas([]);
    if (jobId) {
      // Surface a genuine backend-cancel failure so the caller can toast/retry:
      // if the cancel didn't land, the reconciler could otherwise resurrect the
      // job.
      await postsService.cancelResearch(jobId);
    }
  }, []);

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
      cancelResearch,
      researchingIdeas,
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
      cancelResearch,
      researchingIdeas,
      synthesizeResearch,
      clearResearch,
      clearIdea,
      clearSynthesizedPost,
    ]
  );

  return <PostComposerContext.Provider value={value}>{children}</PostComposerContext.Provider>;
};
