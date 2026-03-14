import { describe, it, expect } from 'vitest';
import { buildLinkedInProfileUrl } from './linkedinUrl';

describe('buildLinkedInProfileUrl', () => {
  it('returns full HTTP URL from linkedin_url as-is', () => {
    const result = buildLinkedInProfileUrl({
      linkedin_url: 'https://www.linkedin.com/in/john-doe',
    });
    expect(result).toBe('https://www.linkedin.com/in/john-doe');
  });

  it('handles http:// URLs too', () => {
    const result = buildLinkedInProfileUrl({
      linkedin_url: 'http://linkedin.com/in/jane',
    });
    expect(result).toBe('http://linkedin.com/in/jane');
  });

  it('builds full URL from in/vanity format', () => {
    const result = buildLinkedInProfileUrl({ linkedin_url: 'in/john-doe' });
    expect(result).toBe('https://www.linkedin.com/in/john-doe');
  });

  it('builds full URL from bare vanity slug', () => {
    const result = buildLinkedInProfileUrl({ linkedin_url: 'john-doe' });
    expect(result).toBe('https://www.linkedin.com/in/john-doe');
  });

  it('trims leading/trailing slashes from linkedin_url', () => {
    const result = buildLinkedInProfileUrl({ linkedin_url: '/in/john-doe/' });
    expect(result).toBe('https://www.linkedin.com/in/john-doe');
  });

  it('decodes base64-encoded full URL from id', () => {
    // btoa('https://www.linkedin.com/in/encoded-user') with standard base64
    const encoded = btoa('https://www.linkedin.com/in/encoded-user');
    const result = buildLinkedInProfileUrl({ id: encoded });
    expect(result).toBe('https://www.linkedin.com/in/encoded-user');
  });

  it('decodes base64-encoded vanity slug from id', () => {
    const encoded = btoa('vanity-slug');
    const result = buildLinkedInProfileUrl({ id: encoded });
    expect(result).toBe('https://www.linkedin.com/in/vanity-slug');
  });

  it('decodes base64-encoded in/vanity from id', () => {
    const encoded = btoa('in/some-user');
    const result = buildLinkedInProfileUrl({ id: encoded });
    expect(result).toBe('https://www.linkedin.com/in/some-user');
  });

  it('handles URL-safe base64 characters in id', () => {
    // URL-safe base64 uses - and _ instead of + and /
    const standard = btoa('https://www.linkedin.com/in/test-user');
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = buildLinkedInProfileUrl({ id: urlSafe });
    expect(result).toBe('https://www.linkedin.com/in/test-user');
  });

  it('falls back to people search with name + company', () => {
    const result = buildLinkedInProfileUrl({
      first_name: 'John',
      last_name: 'Doe',
      company: 'Acme Corp',
    });
    expect(result).toBe(
      'https://www.linkedin.com/search/results/people/?keywords=John%20Doe%20Acme%20Corp'
    );
  });

  it('falls back to people search with only name', () => {
    const result = buildLinkedInProfileUrl({
      first_name: 'Jane',
      last_name: 'Smith',
    });
    expect(result).toBe('https://www.linkedin.com/search/results/people/?keywords=Jane%20Smith');
  });

  it('returns null when no data available', () => {
    const result = buildLinkedInProfileUrl({});
    expect(result).toBeNull();
  });

  it('handles empty strings gracefully', () => {
    const result = buildLinkedInProfileUrl({
      linkedin_url: '',
      id: '',
      first_name: '',
      last_name: '',
      company: '',
    });
    expect(result).toBeNull();
  });

  it('handles whitespace-only linkedin_url', () => {
    const result = buildLinkedInProfileUrl({
      linkedin_url: '   ',
      first_name: 'Test',
    });
    expect(result).toBe('https://www.linkedin.com/search/results/people/?keywords=Test');
  });

  it('prefers linkedin_url over id', () => {
    const result = buildLinkedInProfileUrl({
      linkedin_url: 'https://linkedin.com/in/preferred',
      id: btoa('https://linkedin.com/in/not-this'),
    });
    expect(result).toBe('https://linkedin.com/in/preferred');
  });

  it('prefers id over name fallback', () => {
    const encoded = btoa('some-vanity');
    const result = buildLinkedInProfileUrl({
      id: encoded,
      first_name: 'John',
      last_name: 'Doe',
    });
    expect(result).toBe('https://www.linkedin.com/in/some-vanity');
  });
});
