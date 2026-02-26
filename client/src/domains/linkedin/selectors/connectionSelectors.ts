import { SelectorRegistry } from '../../automation/utils/selectorRegistry.js';

export const connectionSelectors: SelectorRegistry = {
    'connection:distance-1st': [
        { strategy: 'puppeteer-text', selector: '[data-test-id="distance-badge"] ::-p-text(1st)' },
        { strategy: 'puppeteer-aria', selector: '::-p-aria([name*="1st degree"])' },
        { strategy: 'css-text', selector: '.distance-badge ::-p-text(1st)' },
        { strategy: 'css', selector: 'span.distance-badge .dist-value' },
    ],
    'connection:pending': [
        { strategy: 'aria', selector: '[aria-label*="Pending" i]' },
        { strategy: 'puppeteer-text', selector: 'button ::-p-text(Pending)' },
        { strategy: 'puppeteer-aria', selector: '::-p-aria([name*="Pending"])' },
        { strategy: 'data-test', selector: '[data-test-id="pending-button"]' },
        { strategy: 'css-aria', selector: 'button[aria-label*="Pending"]' },
    ],
    'connection:accept': [
        { strategy: 'puppeteer-text', selector: 'button ::-p-text(Accept)' },
        { strategy: 'puppeteer-aria', selector: '::-p-aria([name*="Accept"])' },
        { strategy: 'puppeteer-respond', selector: 'button ::-p-text(Respond)' },
        { strategy: 'puppeteer-invitation', selector: '::-p-aria([name*="invitation"])' },
    ],
    'connection:connect-button': [
        { strategy: 'data-view', selector: '[data-view-name="profile-actions-connect"]' },
        { strategy: 'aria', selector: 'button[aria-label*="Connect"]' },
        { strategy: 'data-test', selector: '[data-test-id="connect-button"]' },
        { strategy: 'text', selector: 'button:has-text("Connect")' },
    ],
    'connection:more-button': [
        { strategy: 'aria', selector: 'button[aria-label*="More"]' },
    ],
    'connection:add-note': [
        { strategy: 'text', selector: 'button:has-text("Add a note")' },
    ],
    'connection:note-input': [
        { strategy: 'element', selector: 'textarea' },
    ],
    'connection:send-invitation': [
        { strategy: 'aria', selector: 'button[aria-label*="Send"]' },
        { strategy: 'data-test', selector: '[data-test-id="send-invitation"]' },
        { strategy: 'text', selector: 'button:has-text("Send")' },
    ],
    'connection:invitation-sent': [
        { strategy: 'data-test', selector: '[data-test-id="invitation-sent-confirmation"]' },
    ],
    'connection:modal': [
        { strategy: 'role', selector: '[role="dialog"]' },
        { strategy: 'css-artdeco', selector: '.artdeco-modal' },
        { strategy: 'css-invite', selector: '.send-invite' },
    ],
    'connection:all-buttons': [
        { strategy: 'mixed', selector: 'button,[role="button"],.artdeco-button' },
        { strategy: 'elements', selector: 'button, [role="button"]' },
    ]
};
