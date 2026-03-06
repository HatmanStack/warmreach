import { Badge } from '@/components/ui/badge';
import type { ConversionLikelihood } from '@/shared/types';

interface Props {
  likelihood: ConversionLikelihood;
  className?: string;
}

const colorMap: Record<ConversionLikelihood, string> = {
  high: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-800',
  medium:
    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800',
  low: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 border-red-200 dark:border-red-800',
};

const labelMap: Record<ConversionLikelihood, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * ConversionLikelihoodBadge Component
 *
 * Displays the conversion likelihood as a colored badge.
 * - High: Green styling
 * - Medium: Yellow/amber styling
 * - Low: Red styling
 */
export function ConversionLikelihoodBadge({ likelihood, className = '' }: Props) {
  return (
    <Badge variant="outline" className={`text-xs font-medium ${colorMap[likelihood]} ${className}`}>
      {labelMap[likelihood]}
    </Badge>
  );
}
