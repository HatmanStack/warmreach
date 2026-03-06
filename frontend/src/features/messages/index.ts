// Messages feature barrel export

// Components
export { MessageModal } from './components/MessageModal';
export { default as ConversationTopicPanel } from './components/ConversationTopicPanel';

// Services
export {
  messageGenerationService,
  MessageGenerationError,
} from './services/messageGenerationService';

// Hooks
export { useMessageGeneration } from './hooks/useMessageGeneration';

// Types
export type { MessageGenerationRequest } from './services/messageGenerationService';
