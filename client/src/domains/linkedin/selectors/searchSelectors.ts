import { SelectorRegistry } from '../../automation/utils/selectorRegistry.js';

export const searchSelectors: SelectorRegistry = {
  'search:filter-button': [
    { strategy: 'puppeteer-aria', selector: '::-p-aria({filterName})' },
    { strategy: 'aria-exact', selector: 'button[aria-label="{filterName} filter"]' },
    { strategy: 'aria-partial', selector: 'button[aria-label*="{filterName}"]' },
  ],
  'search:filter-input': [
    { strategy: 'aria-company', selector: 'input[aria-label*="Add a company"]' },
    { strategy: 'aria-location', selector: 'input[aria-label*="Add a location"]' },
    { strategy: 'placeholder', selector: 'input[placeholder*="Add a"]' },
    { strategy: 'role', selector: 'input[role="combobox"]' },
    { strategy: 'role-nested', selector: '[role="listbox"] input' },
    { strategy: 'css', selector: 'fieldset input[type="text"]' },
  ],
  'search:filter-suggestions': [
    { strategy: 'role', selector: '[role="listbox"] [role="option"]' },
    { strategy: 'role-li', selector: '[role="listbox"] li' },
    { strategy: 'css-typeahead', selector: '.basic-typeahead__triggered-content li' },
    { strategy: 'data-label', selector: 'div[data-basic-filter-parameter-values] label' },
    { strategy: 'css-fieldset', selector: 'fieldset label' },
  ],
  'search:apply-filter': [
    { strategy: 'puppeteer-aria-show', selector: '::-p-aria(Show results)' },
    { strategy: 'puppeteer-aria-apply', selector: '::-p-aria(Apply current filter)' },
    { strategy: 'aria-apply', selector: 'button[aria-label*="Apply"]' },
    { strategy: 'aria-show', selector: 'button[aria-label*="Show results"]' },
    { strategy: 'data-control', selector: 'button[data-control-name="filter_show_results"]' },
  ],
  'search:filter-text-buttons': [{ strategy: 'elements', selector: 'button, label' }],
  'search:profile-links': [
    { strategy: 'href', selector: 'a[href*="/in/"]' },
    { strategy: 'data-view-conn', selector: '[data-view-name="connections-profile"]' },
    { strategy: 'data-view-search', selector: '[data-view-name="people-search-result"]' },
    { strategy: 'data-test', selector: '[data-test-id="connection-card"]' },
  ],
  'search:show-more': [
    { strategy: 'aria', selector: 'button[aria-label*="Show more"]' },
    { strategy: 'css-scaffold', selector: '.scaffold-finite-scroll__load-button button' },
    { strategy: 'css-artdeco', selector: 'button.artdeco-button' },
  ],
  'search:result-items': [{ strategy: 'css', selector: 'ul li' }],
  'search:result-profile-links': [
    { strategy: 'href-contains', selector: 'a[href*="/in/"]' },
    { strategy: 'href-starts', selector: 'a[href^="/in/"]' },
    { strategy: 'css-container', selector: '.reusable-search__result-container a[href]' },
  ],
  'search:media-images': [{ strategy: 'src', selector: 'img[src*="media.licdn.com"]' }],
};
