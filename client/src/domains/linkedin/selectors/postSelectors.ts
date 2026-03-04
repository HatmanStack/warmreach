import { SelectorRegistry } from '../../automation/utils/selectorRegistry.js';

export const postSelectors: SelectorRegistry = {
  'post:start-button': [
    { strategy: 'aria', selector: 'button[aria-label*="Start a post" i]' },
    { strategy: 'aria-generic', selector: '[aria-label*="Start a post" i]' },
    { strategy: 'placeholder', selector: 'div[data-placeholder*="Start a post" i]' },
    { strategy: 'data-test', selector: '[data-test-id="start-post-button"]' },
  ],
  'post:content-editor': [
    { strategy: 'aria-editor', selector: '[aria-label*="Text editor" i]' },
    { strategy: 'aria-talk', selector: '[aria-label*="talk about" i]' },
    { strategy: 'placeholder', selector: 'div[data-placeholder*="talk about" i]' },
    { strategy: 'data-test', selector: '[data-test-id="post-content-input"]' },
    { strategy: 'role', selector: '[contenteditable="true"][role="textbox"]' },
    {
      strategy: 'placeholder-full',
      selector: 'div[data-placeholder*="What do you want to talk about"]',
    },
    { strategy: 'css-share', selector: '.share-creation-state__text-editor' },
    { strategy: 'css-mentions', selector: '.mentions-texteditor__content' },
  ],
  'post:media-upload': [
    { strategy: 'data-test', selector: '[data-test-id="media-upload-button"]' },
    { strategy: 'aria-media', selector: '[aria-label*="Add media"]' },
    { strategy: 'aria-photo', selector: '[aria-label*="Add photo"]' },
    {
      strategy: 'css-aria',
      selector: '.share-actions__primary-action button[aria-label*="media"]',
    },
    { strategy: 'data-control', selector: 'button[data-control-name="add_media"]' },
  ],
  'post:upload-input': [{ strategy: 'aria', selector: 'button[aria-label*="Upload"]' }],
  'post:media-button': [
    { strategy: 'data-test', selector: '[data-test-id="media-button"]' },
    { strategy: 'aria-add', selector: 'button[aria-label*="Add media"]' },
    { strategy: 'aria-add-lower', selector: 'button[aria-label*="add media"]' },
    { strategy: 'css-aria', selector: '.share-actions-control-button[aria-label*="media"]' },
    { strategy: 'data-control', selector: 'button[data-control-name*="media"]' },
  ],
  'post:publish-button': [
    { strategy: 'aria', selector: 'button[aria-label*="Post"]' },
    { strategy: 'aria-lower', selector: 'button[aria-label*="post"]' },
    { strategy: 'data-test', selector: '[data-test-id="post-button"]' },
    { strategy: 'css', selector: '.share-actions__primary-action' },
    { strategy: 'data-control', selector: 'button[data-control-name*="share.post"]' },
    { strategy: 'text', selector: 'button:has-text("Post")' },
  ],
  'post:following-button': [
    { strategy: 'aria', selector: '[aria-label*="Following" i]' },
    { strategy: 'button-aria', selector: 'button[aria-label*="Following" i]' },
    { strategy: 'data-test', selector: '[data-test-id="following-button"]' },
  ],
  'post:follow-button': [
    { strategy: 'data-view', selector: '[data-view-name="relationship-building-button"]' },
    {
      strategy: 'aria-not-following',
      selector: '[aria-label*="Follow" i]:not([aria-label*="Following" i])',
    },
    {
      strategy: 'button-aria-not',
      selector: 'button[aria-label*="Follow" i]:not([aria-label*="Following" i])',
    },
    { strategy: 'data-test', selector: '[data-test-id="follow-button"]' },
  ],
  'post:follow-from-menu': [
    { strategy: 'role-menu', selector: 'div[role="menu"] button[aria-label*="Follow"]' },
    {
      strategy: 'css-dropdown',
      selector: '.artdeco-dropdown__content button[aria-label*="Follow"]',
    },
    {
      strategy: 'data-test-menu',
      selector: '[data-test-id="overflow-menu"] button[aria-label*="Follow"]',
    },
  ],
};
