import { SelectorRegistry } from '../../automation/utils/selectorRegistry.js';

/**
 * Selectors for a contact's shared/mutual-connections surface — the LinkedIn
 * people-search results filtered to your 1st-degree connections who are also
 * connected to that contact.
 *
 * Each cascade lists fallbacks tried in order, so a minor DOM change degrades to
 * the next candidate instead of failing. Consumed by MutualConnectionsCollector,
 * which returns an empty result (never throws) when none of the cascades match.
 */
export const sharedConnectionsSelectors: SelectorRegistry = {
  // The results list container. Absent => the surface did not render for this contact.
  'shared-connections:results-list': [
    { strategy: 'css-entity-result-list', selector: 'ul.reusable-search__entity-result-list' },
    { strategy: 'css-results-container', selector: '.search-results-container ul[role="list"]' },
    { strategy: 'css-role-list', selector: 'ul[role="list"]' },
  ],
  // Each person result card. One shared connection per card (per-card attribution).
  'shared-connections:result-item': [
    { strategy: 'css-result-container', selector: 'li.reusable-search__result-container' },
    { strategy: 'css-entity-result', selector: 'li.entity-result' },
    { strategy: 'css-li', selector: 'li' },
  ],
  // The profile anchor inside a card. Its /in/{slug} href is the shared connection's id.
  'shared-connections:profile-link': [
    { strategy: 'css-entity-title', selector: 'a.entity-result__title-text[href*="/in/"]' },
    { strategy: 'css-app-aware', selector: 'a.app-aware-link[href*="/in/"]' },
    { strategy: 'css-in-href', selector: 'a[href*="/in/"]' },
  ],
};
