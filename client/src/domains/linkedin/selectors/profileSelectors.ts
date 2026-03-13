import { SelectorRegistry } from '../../automation/utils/selectorRegistry.js';

export const profileSelectors: SelectorRegistry = {
  // Existing interaction selectors
  'profile:activity-time': [
    { strategy: 'attr', selector: 'span[aria-hidden="true"]' },
    { strategy: 'component', selector: 'p[componentkey]' },
  ],
  'profile:profile-link': [{ strategy: 'href', selector: 'a[href*="/in/"]' }],
  'profile:all-links': [{ strategy: 'href', selector: 'a[href]' }],
  'profile:body': [{ strategy: 'element', selector: 'body' }],

  // Profile page scraping selectors
  'profile:scrape-name': [
    { strategy: 'data-test', selector: '[data-test-id="profile-name"]' },
    { strategy: 'aria', selector: 'h1[aria-label]' },
    { strategy: 'css-structural', selector: 'section.top-card h1' },
    { strategy: 'css-fallback', selector: '.pv-top-card h1, .ph5 h1, main h1' },
  ],
  'profile:scrape-headline': [
    { strategy: 'data-test', selector: '[data-test-id="profile-headline"]' },
    { strategy: 'css-structural', selector: 'section.top-card .text-body-medium' },
    {
      strategy: 'css-fallback',
      selector: '.pv-top-card .text-body-medium, .ph5 .text-body-medium, .headline',
    },
  ],
  'profile:scrape-location': [
    { strategy: 'data-test', selector: '[data-test-id="profile-location"]' },
    { strategy: 'css-structural', selector: 'section.top-card .text-body-small.inline' },
    {
      strategy: 'css-fallback',
      selector: '.pv-top-card .text-body-small, .ph5 .text-body-small, .location',
    },
  ],
  'profile:scrape-about': [
    { strategy: 'data-test', selector: '[data-test-id="about-section"]' },
    { strategy: 'aria', selector: 'section[aria-label="About"] .inline-show-more-text' },
    { strategy: 'css-structural', selector: '#about ~ .display-flex .inline-show-more-text' },
    {
      strategy: 'css-fallback',
      selector: '.pv-about-section .pv-about__summary-text, section.summary .inline-show-more-text',
    },
  ],
  'profile:scrape-experience-section': [
    { strategy: 'aria', selector: 'section[aria-label="Experience"]' },
    { strategy: 'css-structural', selector: '#experience ~ .display-flex, #experience-section' },
    { strategy: 'css-fallback', selector: 'section.experience-section, .pv-experience-section' },
  ],
  'profile:scrape-experience-item': [
    { strategy: 'css-structural', selector: 'li.artdeco-list__item' },
    {
      strategy: 'css-fallback',
      selector: '.pv-entity__position-group-pager li, .experience-item, li[class*="experience"]',
    },
  ],
  'profile:scrape-experience-title': [
    { strategy: 'css-structural', selector: 'span[aria-hidden="true"]' },
    { strategy: 'css-fallback', selector: '.t-bold span, .pv-entity__summary-info h3' },
  ],
  'profile:scrape-experience-company': [
    { strategy: 'css-structural', selector: 'span.t-normal:not(.t-black--light)' },
    { strategy: 'css-fallback', selector: '.pv-entity__secondary-title, .t-14.t-normal span' },
  ],
  'profile:scrape-experience-date': [
    { strategy: 'css-structural', selector: 'span.t-black--light span[aria-hidden="true"]' },
    {
      strategy: 'css-fallback',
      selector: '.pv-entity__date-range span:nth-child(2), .date-range span',
    },
  ],
  'profile:scrape-experience-description': [
    { strategy: 'css-structural', selector: '.inline-show-more-text' },
    { strategy: 'css-fallback', selector: '.pv-entity__description, .show-more-less-text' },
  ],
  'profile:scrape-education-section': [
    { strategy: 'aria', selector: 'section[aria-label="Education"]' },
    { strategy: 'css-structural', selector: '#education ~ .display-flex, #education-section' },
    { strategy: 'css-fallback', selector: 'section.education-section, .pv-education-section' },
  ],
  'profile:scrape-education-item': [
    { strategy: 'css-structural', selector: 'li.artdeco-list__item' },
    {
      strategy: 'css-fallback',
      selector: '.pv-entity__degree-info, .education-item, li[class*="education"]',
    },
  ],
  'profile:scrape-education-school': [
    { strategy: 'css-structural', selector: 'span[aria-hidden="true"]' },
    { strategy: 'css-fallback', selector: '.t-bold span, .pv-entity__school-name' },
  ],
  'profile:scrape-education-degree': [
    { strategy: 'css-structural', selector: 'span.t-normal:not(.t-black--light)' },
    {
      strategy: 'css-fallback',
      selector: '.pv-entity__degree-name span:nth-child(2), .pv-entity__fos span',
    },
  ],
  'profile:scrape-education-date': [
    { strategy: 'css-structural', selector: 'span.t-black--light span[aria-hidden="true"]' },
    { strategy: 'css-fallback', selector: '.pv-entity__dates span:nth-child(2), .date-range span' },
  ],
  'profile:scrape-skills-section': [
    { strategy: 'aria', selector: 'section[aria-label="Skills"]' },
    { strategy: 'css-structural', selector: '#skills ~ .display-flex, #skills-section' },
    { strategy: 'css-fallback', selector: 'section.skills-section, .pv-skill-categories-section' },
  ],
  'profile:scrape-skill-item': [
    { strategy: 'css-structural', selector: 'li.artdeco-list__item span[aria-hidden="true"]' },
    {
      strategy: 'css-fallback',
      selector: '.pv-skill-category-entity__name span, .skill-item, li[class*="skill"] span',
    },
  ],

  // Activity page scraping selectors
  'profile:scrape-activity-post': [
    { strategy: 'css-structural', selector: 'div.feed-shared-update-v2' },
    {
      strategy: 'css-fallback',
      selector: '.occludable-update, .feed-shared-update, [data-urn*="activity"]',
    },
  ],
  'profile:scrape-activity-text': [
    { strategy: 'css-structural', selector: '.feed-shared-text .break-words' },
    { strategy: 'css-fallback', selector: '.feed-shared-text span, .update-components-text span' },
  ],
  'profile:scrape-activity-time': [
    { strategy: 'css-structural', selector: 'time.feed-shared-actor__sub-description' },
    {
      strategy: 'css-fallback',
      selector: 'time[datetime], .feed-shared-actor__sub-description span[aria-hidden="true"]',
    },
  ],
};
