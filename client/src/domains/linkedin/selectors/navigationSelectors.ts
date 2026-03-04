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
    { strategy: 'data-view', selector: '[data-view-name="navigation-homepage"]' },
    { strategy: 'data-view-identity', selector: '[data-view-name="identity-module"]' },
    { strategy: 'data-view-self', selector: '[data-view-name="identity-self-profile"]' },
    { strategy: 'combined', selector: 'header, [data-view-name="navigation-homepage"]' },
  ],
  'nav:scaffold': [
    { strategy: 'css', selector: '.scaffold-layout' },
    { strategy: 'element', selector: 'main' },
  ],
  'nav:login-username': [{ strategy: 'id', selector: '#username' }],
  'nav:login-password': [{ strategy: 'id', selector: '#password' }],
  'nav:login-submit': [{ strategy: 'css', selector: 'form button[type="submit"]' }],
  'nav:profile-card-container': [
    { strategy: 'css-full', selector: '#profile-content main section.artdeco-card div.ph5.pb5' },
    { strategy: 'css-section', selector: '#profile-content main section.artdeco-card' },
    { strategy: 'css-main', selector: '#profile-content main' },
    { strategy: 'css-topcard', selector: 'main .pv-top-card' },
    { strategy: 'element', selector: 'main' },
  ],
  'nav:any-test-id': [{ strategy: 'data-test', selector: '[data-test-id]' }],
};
