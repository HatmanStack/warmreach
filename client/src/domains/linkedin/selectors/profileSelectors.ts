import { SelectorRegistry } from '../../automation/utils/selectorRegistry.js';

export const profileSelectors: SelectorRegistry = {
    'profile:activity-time': [
        { strategy: 'attr', selector: 'span[aria-hidden="true"]' },
        { strategy: 'component', selector: 'p[componentkey]' },
    ],
    'profile:profile-link': [
        { strategy: 'href', selector: 'a[href*="/in/"]' },
    ],
    'profile:all-links': [
        { strategy: 'href', selector: 'a[href]' },
    ],
    'profile:body': [
        { strategy: 'element', selector: 'body' },
    ],
};
