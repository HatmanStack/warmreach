import { SelectorRegistry } from '../../automation/utils/selectorRegistry.js';
import { SelectorResolver } from '../../automation/utils/selectorResolver.js';
import { messagingSelectors } from './messagingSelectors.js';
import { connectionSelectors } from './connectionSelectors.js';
import { navigationSelectors } from './navigationSelectors.js';
import { searchSelectors } from './searchSelectors.js';
import { postSelectors } from './postSelectors.js';
import { profileSelectors } from './profileSelectors.js';

export {
    messagingSelectors,
    connectionSelectors,
    navigationSelectors,
    searchSelectors,
    postSelectors,
    profileSelectors,
};

export const linkedinSelectors: SelectorRegistry = {
    ...messagingSelectors,
    ...connectionSelectors,
    ...navigationSelectors,
    ...searchSelectors,
    ...postSelectors,
    ...profileSelectors,
};

export const linkedinResolver = new SelectorResolver(linkedinSelectors);
