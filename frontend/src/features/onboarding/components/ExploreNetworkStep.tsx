import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Network } from 'lucide-react';
import { useOnboarding } from '../hooks/useOnboarding';
import { DEMO_NETWORK_GRAPH } from '../data/demoData';

/**
 * Simple SVG-based network graph preview. Does not import Sigma.
 */
const MiniNetworkPreview = () => {
  const { nodes, edges } = DEMO_NETWORK_GRAPH;

  // Position nodes in a circle
  const cx = 150;
  const cy = 120;
  const radius = 80;
  const positions: Record<string, { x: number; y: number }> = {};

  nodes.forEach((node, i) => {
    if (node.id === 'you') {
      positions[node.id] = { x: cx, y: cy };
    } else {
      const angle = ((i - 1) / (nodes.length - 1)) * 2 * Math.PI - Math.PI / 2;
      positions[node.id] = {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      };
    }
  });

  return (
    <svg viewBox="0 0 300 240" className="w-full max-w-xs mx-auto">
      {/* Edges */}
      {edges.map((edge, i) => {
        const from = positions[edge.source];
        const to = positions[edge.target];
        if (!from || !to) return null;
        return (
          <line
            key={i}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="currentColor"
            strokeOpacity={0.15}
            strokeWidth={1.5}
          />
        );
      })}
      {/* Nodes */}
      {nodes.map((node) => {
        const pos = positions[node.id];
        if (!pos) return null;
        return (
          <g key={node.id}>
            <circle cx={pos.x} cy={pos.y} r={node.size / 2} fill={node.color} opacity={0.8} />
            <text
              x={pos.x}
              y={pos.y + node.size / 2 + 12}
              textAnchor="middle"
              fontSize={9}
              fill="currentColor"
              opacity={0.6}
            >
              {node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

export const ExploreNetworkStep = () => {
  const { completeStep, skipStep } = useOnboarding();
  const navigate = useNavigate();

  const handleExplore = async () => {
    await completeStep('explore_network');
    navigate('/network');
  };

  const handleSkip = async () => {
    await skipStep('explore_network');
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="mx-auto w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
          <Network className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
        </div>
        <h2 className="text-2xl font-bold">Explore Your Network</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          Visualize your professional network as an interactive graph. Discover clusters, find warm
          introduction paths, and identify key connectors.
        </p>
      </div>

      {/* Demo graph preview */}
      <div className="rounded-lg border bg-card/50 p-4">
        <MiniNetworkPreview />
      </div>

      <div className="flex flex-col items-center gap-2">
        <Button onClick={handleExplore} className="min-w-[200px]" data-testid="onboarding-explore">
          Explore Network
        </Button>
        <Button
          variant="ghost"
          onClick={handleSkip}
          className="text-sm text-muted-foreground"
          data-testid="onboarding-skip"
        >
          Skip
        </Button>
      </div>
    </div>
  );
};
