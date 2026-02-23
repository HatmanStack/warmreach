// Connections feature barrel export

// Components
export { default as VirtualConnectionList } from './components/VirtualConnectionList';
export { default as NewConnectionsTab } from './components/NewConnectionsTab';
export { ConnectionListSkeleton } from './components/ConnectionCardSkeleton';
export { RelationshipStrengthBadge } from './components/RelationshipStrengthBadge';
export { MessageIntelligencePanel } from './components/MessageIntelligencePanel';
export { SendTimeRecommendations } from './components/SendTimeRecommendations';
export { PriorityRecommendations } from './components/PriorityRecommendations';
export { ReplyProbabilityBadge } from './components/ReplyProbabilityBadge';
export { ClusterView } from './components/ClusterView';

// Services
export { connectionDataContextService } from './services/connectionDataContextService';

// Utils
export * from './utils/connectionFiltering';

// Hooks
export { useConnectionsManager } from './hooks/useConnectionsManager';
