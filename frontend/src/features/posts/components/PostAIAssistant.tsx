import { useState, useMemo, useRef, type ChangeEvent, type KeyboardEvent, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sparkles, Search, X } from 'lucide-react';
import { usePostComposer } from '../contexts/PostComposerContext';

interface PostAIAssistantProps {
  onGenerateIdeas: (prompt?: string) => Promise<void>;
  onResearchTopics: (topics: string[]) => void;
  onValidationError: (message: string) => void;
  isGeneratingIdeas: boolean;
  isResearching: boolean;
  ideas?: string[];
  onIdeasUpdate?: (newIdeas: string[]) => Promise<void>;
}

const PostAIAssistant = ({
  onGenerateIdeas,
  onResearchTopics,
  isGeneratingIdeas,
  isResearching,
  ideas,
  onIdeasUpdate,
}: PostAIAssistantProps) => {
  const { selectedIdeas: contextSelectedIdeas, updateSelectedIdeas } = usePostComposer();
  const [showResearchInput, setShowResearchInput] = useState(false);
  const [researchQuery, setResearchQuery] = useState('');
  const [ideaPrompt, setIdeaPrompt] = useState('');
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const ideaList = useMemo<string[]>(() => ideas ?? [], [ideas]);

  // One-shot hydration: when an idea list first arrives, restore any
  // selection from the context (e.g. carried over from a sibling component
  // earlier in the session). After that, the local checkboxes own the
  // selection — the downstream sync effect mirrors local → context.
  //
  // This MUST NOT also clear selectedIndices when context is empty: that
  // would race with the sync effect (sync pushes selectedTexts into
  // context, hydration wipes selectedIndices on the next pass) and trip
  // React error #185 (max update depth).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (ideaList.length === 0) return;
    hydratedRef.current = true;
    if (contextSelectedIdeas.length === 0) return;
    const next = new Set<number>();
    ideaList.forEach((idea: string, idx: number) => {
      if (contextSelectedIdeas.includes(idea)) next.add(idx);
    });
    if (next.size > 0) setSelectedIndices(next);
  }, [ideaList, contextSelectedIdeas]);

  // Sync selected ideas to context whenever selection or list changes.
  // Equality-guarded against the context's value to avoid the same
  // ping-pong: only call updateSelectedIdeas when the list actually
  // differs (still allows propagating empty selections).
  useEffect(() => {
    const selectedTexts = Array.from(selectedIndices)
      .map((idx) => ideaList[idx])
      .filter((s): s is string => Boolean(s));
    if (selectedTexts.length === contextSelectedIdeas.length) {
      let same = true;
      for (let i = 0; i < selectedTexts.length; i++) {
        if (selectedTexts[i] !== contextSelectedIdeas[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    updateSelectedIdeas(selectedTexts);
  }, [selectedIndices, ideaList, updateSelectedIdeas, contextSelectedIdeas]);

  const handleResearchSubmit = () => {
    if (researchQuery.trim()) {
      onResearchTopics([researchQuery.trim()]);
      setShowResearchInput(false);
      setResearchQuery('');
    }
  };

  const handleGenerateIdeas = () => {
    onGenerateIdeas(ideaPrompt.trim() || undefined);
  };

  const handleDeleteIdea = async (index: number) => {
    if (!onIdeasUpdate) return;
    // Don't reindex selectedIndices locally before the parent confirms
    // — if onIdeasUpdate fails, our optimistic shift would leave the
    // selection state pointing at the wrong items. Wait for the parent
    // to push canonical ideas back through props; the hydration effect
    // above will then rebuild selection against the new list.
    const newIdeas = ideaList.filter((_, i) => i !== index);
    await onIdeasUpdate(newIdeas);
  };

  const handleIdeaToggle = (index: number) => {
    const newSelected = new Set(selectedIndices);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedIndices(newSelected);
  };

  const handleResearchTopicsClick = () => {
    const hasCustomTopic = Boolean(ideaPrompt.trim());
    const hasSelected = Boolean(ideaList && ideaList.length > 0 && selectedIndices.size > 0);

    // If textarea has content, research the custom topic
    if (hasCustomTopic) {
      onResearchTopics([ideaPrompt.trim()]);
      setIdeaPrompt(''); // Clear the textarea after sending
      return;
    }

    // If we have selected ideas, research those
    if (hasSelected) {
      const selectedIdeasList = Array.from(selectedIndices)
        .map((index) => ideaList[index])
        .filter((s): s is string => Boolean(s));
      onResearchTopics(selectedIdeasList);
      return;
    }

    // If neither, do nothing (button will be disabled in UI)
    setShowResearchInput(false);
  };

  const renderIdeasList = () => (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-white font-semibold">Generated Ideas</h4>
      </div>
      <div className="space-y-2">
        {ideaList?.map((idea, index) => (
          <div
            key={index}
            className="flex items-start space-x-3 p-3 bg-white/5 rounded-md border border-white/10"
          >
            <input
              type="checkbox"
              id={`idea-${index}`}
              checked={selectedIndices.has(index)}
              onChange={() => handleIdeaToggle(index)}
              className="mt-1 h-4 w-4 text-purple-600 bg-white/10 border-white/20 rounded focus:ring-purple-500/40 focus:ring-2"
            />
            <label
              htmlFor={`idea-${index}`}
              className="text-slate-300 text-sm leading-relaxed cursor-pointer flex-1"
            >
              {idea}
            </label>
            {onIdeasUpdate && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/20"
                onClick={() => handleDeleteIdea(index)}
                title="Delete idea"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  const renderTextarea = () => (
    <textarea
      placeholder="Optional idea prompt..."
      value={ideaPrompt}
      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setIdeaPrompt(e.target.value)}
      rows={3}
      className="w-full bg-white/5 border border-white/20 text-white placeholder-slate-400 rounded-md px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500/40"
    />
  );

  return (
    <div className="space-y-6">
      <Card className="bg-white/5 backdrop-blur-md border-white/10">
        <CardHeader>
          <CardTitle className="text-white">AI Assistant</CardTitle>
          <CardDescription className="text-slate-300">
            Get help with content ideas and optimization.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ideaList && ideaList.length > 0 ? renderIdeasList() : renderTextarea()}

          {!ideaList || ideaList.length === 0 ? (
            <Button
              className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white"
              onClick={handleGenerateIdeas}
              disabled={isGeneratingIdeas}
            >
              <Sparkles className="h-4 w-4 mr-2" />
              {isGeneratingIdeas ? 'Generating...' : 'Generate Ideas'}
            </Button>
          ) : null}

          {(() => {
            const hasCustomTopic = Boolean(ideaPrompt.trim());
            const hasSelected = Boolean(
              ideaList && ideaList.length > 0 && selectedIndices.size > 0
            );
            const canResearch = hasCustomTopic || hasSelected;
            return (
              <Button
                className="w-full bg-slate-700 hover:bg-slate-600 text-white border-slate-600 hover:border-slate-500"
                onClick={handleResearchTopicsClick}
                disabled={isResearching || !canResearch}
                title={
                  !canResearch
                    ? 'Enter a topic above or select at least one idea to research'
                    : undefined
                }
              >
                <Search className="h-4 w-4 mr-2" />
                {hasCustomTopic
                  ? 'Research Custom Topic'
                  : hasSelected
                    ? 'Research Selected Ideas'
                    : 'Research Topics'}
              </Button>
            );
          })()}

          {showResearchInput && (
            <div className="space-y-2">
              <Input
                placeholder="Enter research topic..."
                value={researchQuery}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setResearchQuery(e.target.value)}
                className="bg-white/5 border-white/20 text-white placeholder-slate-400"
                onKeyPress={(e: KeyboardEvent<HTMLInputElement>) =>
                  e.key === 'Enter' && handleResearchSubmit()
                }
              />
              <Button
                onClick={handleResearchSubmit}
                disabled={isResearching}
                className="w-full bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700 text-white"
              >
                <Search className="h-4 w-4 mr-2" />
                {isResearching ? 'Researching...' : 'Search'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-slate-700 bg-gradient-to-r from-green-600/20 to-blue-600/20 backdrop-blur-md border-white/10">
        <CardContent className="p-4">
          <h4 className="text-white font-semibold mb-2">📝 Writing Tips</h4>
          <ul className="text-slate-300 text-sm space-y-1">
            <li>• Start with a hook</li>
            <li>• Share personal insights</li>
            <li>• Include a call-to-action</li>
            <li>• Use relevant hashtags</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
};

export default PostAIAssistant;
