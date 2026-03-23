import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, X } from 'lucide-react';

interface InterestsEditorProps {
  interests: string[];
  newInterest: string;
  onNewInterestChange: (value: string) => void;
  onAddInterest: () => void;
  onRemoveInterest: (interest: string) => void;
}

export function InterestsEditor({
  interests,
  newInterest,
  onNewInterestChange,
  onAddInterest,
  onRemoveInterest,
}: InterestsEditorProps) {
  return (
    <Card className="bg-white/5 backdrop-blur-md border-white/10">
      <CardHeader>
        <CardTitle className="text-white">Interests & Expertise</CardTitle>
        <CardDescription className="text-slate-300">
          Add topics you're passionate about to find better conversation opportunities.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex space-x-2">
          <Input
            value={newInterest}
            onChange={(e) => onNewInterestChange(e.target.value)}
            placeholder="Add an interest (e.g., Machine Learning)"
            className="bg-white/5 border-white/20 text-white placeholder-slate-400"
            onKeyPress={(e) => e.key === 'Enter' && onAddInterest()}
          />
          <Button
            onClick={onAddInterest}
            variant="outline"
            className="bg-slate-700 border-white/20 text-white hover:bg-white/10"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          {interests.map((interest, index) => (
            <Badge
              key={index}
              variant="secondary"
              className="bg-blue-600/20 text-blue-300 hover:bg-blue-600/30"
            >
              {interest}
              <button
                onClick={() => onRemoveInterest(interest)}
                className="ml-2 hover:text-red-300"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
