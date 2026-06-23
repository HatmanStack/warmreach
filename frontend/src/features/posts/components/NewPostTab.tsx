import { PostAIAssistant, usePostComposer } from '@/features/posts';
import { ResearchResultsCard } from '@/features/search';
import { useToast } from '@/shared/hooks';
import { Button } from '@/shared/components/ui/button';
import { Copy, Check, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('NewPostTab');

const NewPostTabInner = () => {
  const {
    isGeneratingIdeas,
    isResearching,
    isSynthesizing,
    ideas,
    selectedIdeas,
    researchContent,
    includeResearch,
    synthesizedPost,
    generateIdeas,
    researchTopics,
    synthesizeResearch,
    clearResearch,
    clearIdea,
    clearSynthesizedPost,
  } = usePostComposer();

  // Synthesis needs source material — either selected ideas, included
  // research, or both. Without either, the model has nothing to work
  // from and the call would just emit a generic placeholder.
  const hasIncludedResearch = includeResearch && Boolean(researchContent);
  const canSynthesize = selectedIdeas.length > 0 || hasIncludedResearch;
  const synthesizeDisabledReason = canSynthesize
    ? undefined
    : 'Select at least one idea or include research to synthesize';

  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleGenerateIdeas = async (prompt?: string) => {
    try {
      await generateIdeas(prompt);
    } catch (error) {
      logger.error('Failed to generate ideas', { error });
    }
  };

  const handleClearResearch = async () => {
    try {
      await clearResearch();
    } catch (error) {
      logger.error('Failed to clear research', { error });
      toast({ title: 'Error', description: 'Failed to clear research.', variant: 'destructive' });
    }
  };

  const handleIdeasUpdate = async (newIdeas: string[]) => {
    try {
      await clearIdea(newIdeas);
    } catch (error) {
      logger.error('Failed to update ideas', { error });
    }
  };

  const handleValidationError = (message: string) => {
    toast({ title: 'No Ideas Selected', description: message, variant: 'destructive' });
  };

  const handleSynthesize = async () => {
    try {
      await synthesizeResearch();
    } catch (error) {
      logger.error('Failed to synthesize', { error });
      toast({ title: 'Error', description: 'Failed to synthesize post.', variant: 'destructive' });
    }
  };

  const handleCopy = async () => {
    if (!synthesizedPost) return;
    try {
      await navigator.clipboard.writeText(synthesizedPost);
      setCopied(true);
      toast({ title: 'Copied!', description: 'Post copied to clipboard.' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to copy to clipboard.',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="grid lg:grid-cols-[13fr_7fr] gap-8">
      <div className="space-y-6">
        {/* Synthesize Button */}
        <div className="flex items-center gap-3">
          <Button
            onClick={handleSynthesize}
            disabled={isSynthesizing || isResearching || !canSynthesize}
            title={synthesizeDisabledReason}
            className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white"
          >
            <Sparkles className="h-4 w-4 mr-2" />
            {isSynthesizing ? 'Synthesizing...' : 'Synthesize Post'}
          </Button>
          <span className="text-sm text-muted-foreground">
            Creates a LinkedIn post from your selected ideas and research
          </span>
        </div>

        {/* Synthesized Output */}
        {synthesizedPost && (
          <div className="relative rounded-lg border bg-card p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-muted-foreground">Generated Post</h3>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button variant="ghost" size="sm" onClick={clearSynthesizedPost}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{synthesizedPost}</div>
          </div>
        )}

        {/* Research Results */}
        <ResearchResultsCard isResearching={isResearching} onClear={handleClearResearch} />
      </div>

      <div className="space-y-6">
        <PostAIAssistant
          onGenerateIdeas={handleGenerateIdeas}
          onResearchTopics={researchTopics}
          onValidationError={handleValidationError}
          isGeneratingIdeas={isGeneratingIdeas}
          isResearching={isResearching}
          ideas={ideas}
          onIdeasUpdate={handleIdeasUpdate}
        />
      </div>
    </div>
  );
};

const NewPostTab = () => {
  return <NewPostTabInner />;
};

export default NewPostTab;
