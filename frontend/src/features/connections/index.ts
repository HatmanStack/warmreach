// Connections feature barrel export

// Components
export { default as VirtualConnectionList } from './components/VirtualConnectionList';
export { default as NewConnectionsTab } from './components/NewConnectionsTab';
export { ConnectionListSkeleton } from './components/ConnectionCardSkeleton';
export { RelationshipStrengthBadge } from './components/RelationshipStrengthBadge';
export { MessageIntelligencePanel } from './components/MessageIntelligencePanel';

// Services
export { connectionDataContextService } from './services/connectionDataContextService';

// Utils
export * from './utils/connectionFiltering';

// Hooks
export { useConnectionsManager } from './hooks/useConnectionsManager';
