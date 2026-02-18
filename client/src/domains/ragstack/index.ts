/**
 * RAGStack Domain
 *
 * Provides integration with RAGStack-Lambda for web scraping
 * and knowledge base operations on LinkedIn profiles.
 */

// Types
export * from './types/ragstack.js';

// Services
export { RagstackScrapeService } from './services/ragstackScrapeService.js';
export type { WaitOptions } from './services/ragstackScrapeService.js';

// Utils
export {
  extractLinkedInCookies,
  serializeCookies,
  hasValidLinkedInSession,
} from './utils/cookieExtractor.js';
