/**
 * Smoke test to verify Vitest setup
 */

import { describe, it, expect } from 'vitest';
import { createMockProfile, createMockPage } from './setupTests.js';

describe('Vitest Setup', () => {
  it('should run tests successfully', () => {
    expect(true).toBe(true);
  });

  it('should have access to createMockProfile helper', () => {
    const profile = createMockProfile();
    expect(profile).toHaveProperty('profile_id');
    expect(profile).toHaveProperty('name');
    expect(profile.name).toBe('Test User');
  });

  it('should have access to createMockPage helper', () => {
    const page = createMockPage();
    expect(page).toHaveProperty('goto');
    expect(page).toHaveProperty('click');
    expect(typeof page.goto).toBe('function');
  });

  it('should allow mock profile overrides', () => {
    const profile = createMockProfile({ name: 'Custom Name' });
    expect(profile.name).toBe('Custom Name');
    expect(profile.headline).toBe('Software Engineer at Test Company');
  });
});
