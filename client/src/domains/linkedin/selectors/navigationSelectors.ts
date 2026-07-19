import { SelectorRegistry } from '../../automation/utils/selectorRegistry.js';

export const navigationSelectors: SelectorRegistry = {
  'nav:profile-indicator': [
    { strategy: 'data-view-photo', selector: '[data-view-name="profile-top-card-member-photo"]' },
    { strategy: 'data-view-badge', selector: '[data-view-name="profile-top-card-verified-badge"]' },
    { strategy: 'data-view-level', selector: '[data-view-name="profile-main-level"]' },
    { strategy: 'data-view-self', selector: '[data-view-name="profile-self-view"]' },
    { strategy: 'data-test', selector: '[data-test-id="profile-top-card"]' },
  ],
  'nav:main-content': [
    { strategy: 'element-role', selector: 'main, [role="main"]' },
    { strategy: 'element', selector: 'main' },
  ],
  'nav:page-loaded': [
    { strategy: 'data-view', selector: '[data-view-name*="navigation-"]' },
    { strategy: 'element', selector: 'header' },
    { strategy: 'data-view-home', selector: '[data-view-name="navigation-homepage"]' },
    { strategy: 'links', selector: 'a[href]' },
  ],
  'nav:homepage': [
    // LinkedIn dropped the data-view-name attributes; the logged-in shell now
    // exposes stable data-testid hooks. primary-nav is present on every
    // logged-in page (the global nav bar); mainFeed confirms the feed.
    { strategy: 'data-testid-nav', selector: '[data-testid="primary-nav"]' },
    { strategy: 'data-testid-feed', selector: '[data-testid="mainFeed"]' },
    { strategy: 'aria-home', selector: '[aria-label^="Home,"]' },
    // Legacy markup fallbacks (older LinkedIn versions)
    { strategy: 'data-view', selector: '[data-view-name="navigation-homepage"]' },
    { strategy: 'data-view-identity', selector: '[data-view-name="identity-module"]' },
    { strategy: 'data-view-self', selector: '[data-view-name="identity-self-profile"]' },
    { strategy: 'combined', selector: 'header, [data-view-name="navigation-homepage"]' },
  ],
  'nav:scaffold': [
    { strategy: 'css', selector: '.scaffold-layout' },
    { strategy: 'element', selector: 'main' },
  ],
  // LinkedIn rewrote /login as a React app (no <form>, dynamic useId() ids
  // like id="«R…»", obfuscated classes, no name="session_key"). The legacy
  // #username/#password ids are kept first for backward-compat, then we fall
  // through to the stable attribute hooks the new markup still exposes.
  'nav:login-username': [
    { strategy: 'id', selector: '#username' },
    { strategy: 'autocomplete', selector: 'input[autocomplete="username"]' },
    { strategy: 'type-email', selector: 'input[type="email"]' },
  ],
  'nav:login-password': [
    { strategy: 'id', selector: '#password' },
    { strategy: 'autocomplete', selector: 'input[autocomplete="current-password"]' },
    { strategy: 'type-password', selector: 'input[type="password"]' },
  ],
  // The submit control is now a <button type="button"> (React click handler,
  // no <form>), so it can only be matched by its visible "Sign in" text.
  'nav:login-submit': [
    { strategy: 'xpath-text', selector: '::-p-xpath(//button[normalize-space(.)="Sign in"])' },
    { strategy: 'css-submit', selector: 'button[type="submit"]' },
    { strategy: 'css-form-submit', selector: 'form button[type="submit"]' },
  ],
  'nav:profile-card-container': [
    { strategy: 'css-full', selector: '#profile-content main section.artdeco-card div.ph5.pb5' },
    { strategy: 'css-section', selector: '#profile-content main section.artdeco-card' },
    { strategy: 'css-main', selector: '#profile-content main' },
    { strategy: 'css-topcard', selector: 'main .pv-top-card' },
    { strategy: 'element', selector: 'main' },
  ],
  'nav:any-test-id': [{ strategy: 'data-test', selector: '[data-test-id]' }],
};
