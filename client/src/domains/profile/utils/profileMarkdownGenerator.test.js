/**
 * Unit tests for Profile Markdown Generator
 */

import { describe, it, expect } from 'vitest';
import { generateProfileMarkdown } from './profileMarkdownGenerator.js';
import { createMockProfile } from '../../../setupTests.js';

describe('generateProfileMarkdown', () => {
  describe('complete profile', () => {
    it('should generate markdown for complete profile', () => {
      const profile = createMockProfile();
      const markdown = generateProfileMarkdown(profile);

      expect(markdown).toContain('# Test User');
      expect(markdown).toContain('**Headline:** Software Engineer at Test Company');
      expect(markdown).toContain('**Location:** San Francisco, CA');
      expect(markdown).toContain('**Profile ID:**');
      expect(markdown).toContain('## About');
      expect(markdown).toContain('## Current Position');
      expect(markdown).toContain('## Experience');
      expect(markdown).toContain('## Education');
      expect(markdown).toContain('## Skills');
    });

    it('should include all experience entries', () => {
      const profile = createMockProfile({
        experience: [
          {
            company: 'Company A',
            title: 'Senior Engineer',
            start_date: '2023-01',
            end_date: 'Present',
          },
          {
            company: 'Company B',
            title: 'Junior Engineer',
            start_date: '2020-01',
            end_date: '2022-12',
          },
        ],
      });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('### Company A');
      expect(markdown).toContain('### Company B');
      expect(markdown).toContain('Senior Engineer');
      expect(markdown).toContain('Junior Engineer');
    });

    it('should include all education entries', () => {
      const profile = createMockProfile({
        education: [
          {
            school: 'MIT',
            degree: 'PhD',
            field_of_study: 'Computer Science',
          },
          {
            school: 'Stanford',
            degree: 'MS',
            field_of_study: 'AI',
          },
        ],
      });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('### MIT');
      expect(markdown).toContain('### Stanford');
      expect(markdown).toContain('PhD in Computer Science');
      expect(markdown).toContain('MS in AI');
    });

    it('should format skills as comma-separated list', () => {
      const profile = createMockProfile({
        skills: ['JavaScript', 'Python', 'React'],
      });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('## Skills');
      expect(markdown).toContain('JavaScript, Python, React');
    });
  });

  describe('minimal profile', () => {
    it('should generate markdown with only required fields', () => {
      const profile = {
        profile_id: 'test123',
        url: 'https://linkedin.com/in/test',
        name: 'Minimal User',
        extracted_at: '2025-01-01T00:00:00.000Z',
      };

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('# Minimal User');
      expect(markdown).toContain('**Profile ID:** test123');
      expect(markdown).not.toContain('## About');
      expect(markdown).not.toContain('## Experience');
      expect(markdown).not.toContain('## Education');
      expect(markdown).not.toContain('## Skills');
    });

    it('should handle null optional fields', () => {
      const profile = {
        profile_id: 'test123',
        url: 'https://linkedin.com/in/test',
        name: 'Test User',
        headline: null,
        location: null,
        current_position: null,
        experience: null,
        education: null,
        skills: null,
        about: null,
        extracted_at: '2025-01-01T00:00:00.000Z',
      };

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('# Test User');
      expect(markdown).not.toContain('## About');
    });
  });

  describe('empty arrays', () => {
    it('should handle empty experience array', () => {
      const profile = createMockProfile({ experience: [] });
      const markdown = generateProfileMarkdown(profile);
      expect(markdown).not.toContain('## Experience');
    });

    it('should handle empty education array', () => {
      const profile = createMockProfile({ education: [] });
      const markdown = generateProfileMarkdown(profile);
      expect(markdown).not.toContain('## Education');
    });

    it('should handle empty skills array', () => {
      const profile = createMockProfile({ skills: [] });
      const markdown = generateProfileMarkdown(profile);
      expect(markdown).not.toContain('## Skills');
    });
  });

  describe('long about section', () => {
    it('should truncate very long about section', () => {
      const longAbout = 'A'.repeat(6000);
      const profile = createMockProfile({ about: longAbout });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('## About');
      expect(markdown).toContain('...');
      // Should be truncated to 5000 chars + '...'
      expect(markdown.length).toBeLessThan(longAbout.length + 500);
    });

    it('should not truncate about section under limit', () => {
      const shortAbout = 'This is a short about section.';
      const profile = createMockProfile({ about: shortAbout });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain(shortAbout);
      expect(markdown).not.toContain('...');
    });
  });

  describe('special characters', () => {
    it('should escape markdown special characters', () => {
      const profile = createMockProfile({
        name: 'Test *User*',
        headline: '_Italic_ headline',
        about: 'About with <html> tags',
      });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('\\*User\\*');
      expect(markdown).toContain('\\_Italic\\_');
      expect(markdown).toContain('&lt;html&gt;');
    });

    it('should handle backslashes in text', () => {
      const profile = createMockProfile({
        about: 'Path: C:\\Users\\Test',
      });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('C:\\\\Users\\\\Test');
    });
  });

  describe('profile ID consistency', () => {
    it('should include profile ID in output', () => {
      const profileId = 'dGVzdC1wcm9maWxlLWlk';
      const profile = createMockProfile({ profile_id: profileId });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain(`**Profile ID:** ${profileId}`);
    });

    it('should preserve base64 encoded profile ID', () => {
      const base64Id = 'aHR0cHM6Ly93d3cubGlua2VkaW4uY29tL2luL2pvaG5kb2U=';
      const profile = createMockProfile({ profile_id: base64Id });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain(base64Id);
    });
  });

  describe('experience ordering', () => {
    it('should order experience entries chronologically (most recent first)', () => {
      const profile = createMockProfile({
        experience: [
          { company: 'Old Company', title: 'Old Role', start_date: '2018-01' },
          { company: 'New Company', title: 'New Role', start_date: '2023-01' },
          { company: 'Mid Company', title: 'Mid Role', start_date: '2020-06' },
        ],
      });

      const markdown = generateProfileMarkdown(profile);
      const newIndex = markdown.indexOf('New Company');
      const midIndex = markdown.indexOf('Mid Company');
      const oldIndex = markdown.indexOf('Old Company');

      expect(newIndex).toBeLessThan(midIndex);
      expect(midIndex).toBeLessThan(oldIndex);
    });
  });

  describe('error handling', () => {
    it('should throw error for null profile', () => {
      expect(() => generateProfileMarkdown(null)).toThrow('Profile must be a non-null object');
    });

    it('should throw error for undefined profile', () => {
      expect(() => generateProfileMarkdown(undefined)).toThrow('Profile must be a non-null object');
    });

    it('should throw error for non-object profile', () => {
      expect(() => generateProfileMarkdown('string')).toThrow('Profile must be a non-null object');
    });

    it('should throw error for profile without name', () => {
      const profile = { profile_id: 'test' };
      expect(() => generateProfileMarkdown(profile)).toThrow('Profile must have a name');
    });
  });

  describe('date formatting', () => {
    it('should format date ranges correctly', () => {
      const profile = createMockProfile({
        current_position: {
          company: 'Test Co',
          title: 'Engineer',
          start_date: '2023-01',
          end_date: 'Present',
        },
      });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('2023-01 - Present');
    });

    it('should handle missing start date', () => {
      const profile = createMockProfile({
        current_position: {
          company: 'Test Co',
          title: 'Engineer',
          end_date: '2024-01',
        },
      });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('Unknown - 2024-01');
    });

    it('should handle missing end date', () => {
      const profile = createMockProfile({
        current_position: {
          company: 'Test Co',
          title: 'Engineer',
          start_date: '2023-01',
        },
      });

      const markdown = generateProfileMarkdown(profile);
      expect(markdown).toContain('2023-01 - Present');
    });
  });
});
