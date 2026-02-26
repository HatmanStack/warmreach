import { SelectorRegistry } from '../../automation/utils/selectorRegistry.js';

export const messagingSelectors: SelectorRegistry = {
    'messaging:message-button': [
        { strategy: 'aria', selector: 'button[aria-label*="Message"]' },
        { strategy: 'data-view', selector: '[data-view-name="message-button"]' },
        { strategy: 'data-test', selector: '[data-test-id="message-button"]' },
        { strategy: 'text', selector: 'button:has-text("Message")' },
    ],
    'messaging:message-input': [
        { strategy: 'role', selector: '[contenteditable="true"][role="textbox"]' },
        { strategy: 'aria', selector: '[role="textbox"][aria-label*="message"]' },
        { strategy: 'aria-write', selector: '[aria-label*="Write" i][contenteditable="true"]' },
        { strategy: 'data-test', selector: '[data-test-id="message-input"]' },
        { strategy: 'css', selector: '.msg-form__contenteditable' },
        { strategy: 'generic', selector: 'div[contenteditable="true"]' },
    ],
    'messaging:send-button': [
        { strategy: 'aria', selector: 'button[aria-label*="Send" i]' },
        { strategy: 'data-test', selector: '[data-test-id="send-button"]' },
        { strategy: 'type', selector: 'button[type="submit"]' },
        { strategy: 'text', selector: 'button:has-text("Send")' },
    ],
    'messaging:sent-confirmation': [
        { strategy: 'css-sent', selector: '.msg-s-message-list-item--sent' },
        { strategy: 'css-card', selector: '.msg-conversation-card__message--sent' },
        { strategy: 'css-conv', selector: '.messaging-conversation-item--sent' },
        { strategy: 'data-test', selector: '[data-test-id="message-sent"]' },
        { strategy: 'css-last', selector: '.msg-s-message-list__event--last-event' },
    ],
    'messaging:conversation-list': [
        { strategy: 'data-view', selector: '[data-view-name*="conversation"]' },
        { strategy: 'css', selector: '.msg-conversations-container__conversations-list' },
        { strategy: 'css-item', selector: '.msg-conversation-listitem' },
        { strategy: 'css-ul', selector: 'ul.msg-conversations-container__conversations-list' },
    ],
    'messaging:conversation-items': [
        { strategy: 'css-li', selector: 'li[class*="msg-conversation"]' },
        { strategy: 'css-container', selector: '.msg-conversations-container__conversations-list li' },
    ],
    'messaging:message-list': [
        { strategy: 'css', selector: '.msg-s-message-list' },
        { strategy: 'css-partial', selector: '[class*="msg-s-message-list"]' },
        { strategy: 'role', selector: '[role="list"]' },
    ],
    'messaging:message-events': [
        { strategy: 'css', selector: '.msg-s-event-listitem' },
        { strategy: 'data-view', selector: '[data-view-name*="message"]' },
        { strategy: 'css-list', selector: '.msg-s-message-list__event' },
    ],
    'messaging:timestamp': [
        { strategy: 'attr', selector: 'time[datetime]' },
        { strategy: 'css', selector: '.msg-s-message-list__time-heading' },
    ],
    'messaging:other-message': [
        { strategy: 'css', selector: '.msg-s-event-listitem--other' },
        { strategy: 'css-partial', selector: '[class*="msg-s-event-listitem--other"]' },
    ]
};
