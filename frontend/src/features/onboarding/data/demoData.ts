/**
 * Static demo data for onboarding step previews.
 * Pure static data — no backend calls, instant rendering.
 */

import type { Connection } from '@/shared/types';

// ---------------------------------------------------------------------------
// Demo Connections
// ---------------------------------------------------------------------------

export const DEMO_CONNECTIONS: Connection[] = [
  {
    id: 'demo-1',
    first_name: 'Sarah',
    last_name: 'Chen',
    position: 'VP of Engineering',
    company: 'Stripe',
    location: 'San Francisco, CA',
    headline: 'Building the future of payments infrastructure',
    status: 'ally',
    profile_picture_url: 'https://i.pravatar.cc/150?u=demo-sarah-chen',
    tags: ['engineering', 'fintech'],
    isFakeData: true,
  },
  {
    id: 'demo-2',
    first_name: 'Marcus',
    last_name: 'Johnson',
    position: 'Product Lead',
    company: 'Figma',
    location: 'New York, NY',
    headline: 'Design tools for collaborative teams',
    status: 'ally',
    profile_picture_url: 'https://i.pravatar.cc/150?u=demo-marcus-johnson',
    tags: ['product', 'design'],
    isFakeData: true,
  },
  {
    id: 'demo-3',
    first_name: 'Priya',
    last_name: 'Patel',
    position: 'Head of AI Research',
    company: 'Anthropic',
    location: 'San Francisco, CA',
    headline: 'Making AI systems more reliable and interpretable',
    status: 'possible',
    conversion_likelihood: 'high',
    profile_picture_url: 'https://i.pravatar.cc/150?u=demo-priya-patel',
    tags: ['ai', 'research'],
    isFakeData: true,
  },
  {
    id: 'demo-4',
    first_name: 'Alex',
    last_name: 'Rivera',
    position: 'Founding Engineer',
    company: 'Linear',
    location: 'Remote',
    headline: 'Crafting developer tools that spark joy',
    status: 'outgoing',
    profile_picture_url: 'https://i.pravatar.cc/150?u=demo-alex-rivera',
    tags: ['startups', 'developer-tools'],
    isFakeData: true,
  },
  {
    id: 'demo-5',
    first_name: 'Emily',
    last_name: 'Zhang',
    position: 'Partner',
    company: 'Sequoia Capital',
    location: 'Menlo Park, CA',
    headline: 'Investing in builders who shape the future',
    status: 'possible',
    conversion_likelihood: 'medium',
    profile_picture_url: 'https://i.pravatar.cc/150?u=demo-emily-zhang',
    tags: ['vc', 'investing'],
    isFakeData: true,
  },
  {
    id: 'demo-6',
    first_name: 'James',
    last_name: "O'Brien",
    position: 'CTO',
    company: 'Vercel',
    location: 'San Francisco, CA',
    headline: 'Frontend cloud for the modern web',
    status: 'ally',
    profile_picture_url: 'https://i.pravatar.cc/150?u=demo-james-obrien',
    tags: ['infrastructure', 'frontend'],
    isFakeData: true,
  },
  {
    id: 'demo-7',
    first_name: 'Lisa',
    last_name: 'Nakamura',
    position: 'Director of Engineering',
    company: 'Datadog',
    location: 'Boston, MA',
    headline: 'Observability at scale',
    status: 'possible',
    conversion_likelihood: 'high',
    profile_picture_url: 'https://i.pravatar.cc/150?u=demo-lisa-nakamura',
    tags: ['observability', 'engineering'],
    isFakeData: true,
  },
  {
    id: 'demo-8',
    first_name: 'David',
    last_name: 'Kim',
    position: 'Staff Engineer',
    company: 'Netflix',
    location: 'Los Gatos, CA',
    headline: 'Streaming infrastructure and distributed systems',
    status: 'outgoing',
    profile_picture_url: 'https://i.pravatar.cc/150?u=demo-david-kim',
    tags: ['distributed-systems', 'streaming'],
    isFakeData: true,
  },
];

// ---------------------------------------------------------------------------
// Demo Network Graph
// ---------------------------------------------------------------------------

interface NetworkNode {
  id: string;
  label: string;
  size: number;
  color: string;
}

interface NetworkEdge {
  source: string;
  target: string;
}

interface DemoNetworkGraph {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

export const DEMO_NETWORK_GRAPH: DemoNetworkGraph = {
  nodes: [
    { id: 'you', label: 'You', size: 20, color: '#3b82f6' },
    { id: 'n1', label: 'Sarah C.', size: 14, color: '#10b981' },
    { id: 'n2', label: 'Marcus J.', size: 12, color: '#10b981' },
    { id: 'n3', label: 'Priya P.', size: 10, color: '#f59e0b' },
    { id: 'n4', label: 'Alex R.', size: 11, color: '#8b5cf6' },
    { id: 'n5', label: 'Emily Z.', size: 13, color: '#f59e0b' },
    { id: 'n6', label: 'James O.', size: 12, color: '#10b981' },
    { id: 'n7', label: 'Lisa N.', size: 10, color: '#f59e0b' },
  ],
  edges: [
    { source: 'you', target: 'n1' },
    { source: 'you', target: 'n2' },
    { source: 'you', target: 'n6' },
    { source: 'n1', target: 'n3' },
    { source: 'n1', target: 'n5' },
    { source: 'n2', target: 'n4' },
    { source: 'n3', target: 'n7' },
    { source: 'n4', target: 'n6' },
    { source: 'n5', target: 'n7' },
    { source: 'n6', target: 'n1' },
  ],
};
