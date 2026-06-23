import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip';
import { Info, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePostComposer } from '@/features/posts';

interface ResearchResultsCardProps {
  isResearching: boolean;
  onClear: () => void;
}

const ResearchResultsCard = ({ isResearching, onClear }: ResearchResultsCardProps) => {
  // Research content is the canonical user-profile field, hydrated by
  // PostComposerContext from DynamoDB. No client-side cache.
  const { researchContent, includeResearch, setIncludeResearch } = usePostComposer();

  if (!isResearching && !researchContent) return null;

  const showInclusionToggle = Boolean(researchContent) && !isResearching;

  return (
    <Card className="bg-white/5 backdrop-blur-md border-white/10">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            {showInclusionToggle && (
              <input
                type="checkbox"
                id="include-research"
                checked={includeResearch}
                onChange={(e) => setIncludeResearch(e.target.checked)}
                className="mt-1.5 h-4 w-4 text-purple-600 bg-white/10 border-white/20 rounded focus:ring-purple-500/40 focus:ring-2"
                aria-label="Include research in synthesis"
              />
            )}
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-white">Research</CardTitle>
                {showInclusionToggle && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-slate-400 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500/40 rounded"
                        aria-label="What does the checkbox do?"
                      >
                        <Info className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      When checked, this research is fed into the synthesizer alongside your
                      selected ideas. Uncheck to synthesize from ideas alone.
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <CardDescription className="text-slate-300">
                {isResearching ? 'Research in progress…' : 'Research results'}
              </CardDescription>
            </div>
          </div>
          {researchContent && !isResearching ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/20"
              onClick={() => {
                onClear();
              }}
              title="Clear research"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isResearching && (
          <div className="flex items-center text-slate-300 text-sm">
            <svg
              className="animate-spin -ml-1 mr-2 h-4 w-4 text-blue-400"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              ></circle>
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              ></path>
            </svg>
            This may take several minutes.
          </div>
        )}
        {researchContent && (
          <div className="space-y-3">
            <div className="text-white prose prose-invert max-w-none whitespace-pre-wrap break-words prose-h1:text-center prose-headings:text-white">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: (props) => <p {...props} />,
                  h1: (props) => <h1 {...props} className="text-center text-white -mb-2" />,
                  h2: (props) => <h2 {...props} className="text-center text-white -mb-2" />,
                  h3: (props) => <h3 {...props} className="text-white -mb-2" />,
                  h4: (props) => <h4 {...props} className="text-white -mb-2" />,
                  ul: (props) => (
                    <ul
                      {...props}
                      className="list-none pl-0 my-1 space-y-1"
                      style={{ listStyleType: 'none' }}
                    />
                  ),
                  ol: (props) => (
                    <ol
                      {...props}
                      className="list-none pl-0 my-1 space-y-1"
                      style={{ listStyleType: 'none' }}
                    />
                  ),
                  li: (props) => (
                    <li {...props} className="pl-0 my-0.5 marker:text-transparent before:hidden" />
                  ),
                }}
              >
                {researchContent}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ResearchResultsCard;
