import { describe, it, expect } from 'vitest';
import {
  validateConnection,
  validateMessage,
  sanitizeConnectionData,
  validateConnections,
  sanitizeConnectionStatus,
  sanitizeMessageSender,
  sanitizeTimestamp,
  sanitizeString,
} from './validators';

describe('Validators', () => {
  describe('sanitizeString', () => {
    it('should return trimmed string if valid', () => {
      expect(sanitizeString('  hello  ', 'fallback')).toBe('hello');
    });
    it('should return fallback if invalid', () => {
      expect(sanitizeString('', 'fallback')).toBe('fallback');
      expect(sanitizeString(null, 'fallback')).toBe('fallback');
    });
  });

  describe('sanitizeConnectionStatus', () => {
    it('should pass through valid status', () => {
      expect(sanitizeConnectionStatus('ally')).toBe('ally');
    });
    it('should map various aliases', () => {
      expect(sanitizeConnectionStatus('new')).toBe('possible');
      expect(sanitizeConnectionStatus('potential')).toBe('possible');
      expect(sanitizeConnectionStatus('pending')).toBe('incoming');
      expect(sanitizeConnectionStatus('received')).toBe('incoming');
      expect(sanitizeConnectionStatus('sent')).toBe('outgoing');
      expect(sanitizeConnectionStatus('requested')).toBe('outgoing');
      expect(sanitizeConnectionStatus('connected')).toBe('ally');
      expect(sanitizeConnectionStatus('accepted')).toBe('ally');
      expect(sanitizeConnectionStatus('removed')).toBe('processed');
      expect(sanitizeConnectionStatus('ignored')).toBe('processed');
    });
    it('should return null for unknown status', () => {
      expect(sanitizeConnectionStatus('alien')).toBeNull();
      expect(sanitizeConnectionStatus(123)).toBeNull();
    });
  });

  describe('sanitizeMessageSender', () => {
    it('should map various aliases', () => {
      expect(sanitizeMessageSender('me')).toBe('user');
      expect(sanitizeMessageSender('self')).toBe('user');
      expect(sanitizeMessageSender('contact')).toBe('connection');
      expect(sanitizeMessageSender('them')).toBe('connection');
      expect(sanitizeMessageSender('other')).toBe('connection');
    });
    it('should return null for unknown', () => {
      expect(sanitizeMessageSender('robot')).toBeNull();
    });
  });

  describe('sanitizeTimestamp', () => {
    it('should handle Date objects', () => {
      const d = new Date();
      expect(sanitizeTimestamp(d)).toBe(d.toISOString());
    });
    it('should handle numbers', () => {
      const n = Date.now();
      expect(sanitizeTimestamp(n)).toBe(new Date(n).toISOString());
    });
    it('should return null for invalid', () => {
      expect(sanitizeTimestamp('not-a-date')).toBeNull();
      expect(sanitizeTimestamp(NaN)).toBeNull();
    });
  });

  describe('sanitizeConnectionData', () => {
    it('should handle full object with all branches', () => {
      const raw = {
        id: 'id1',
        first_name: 'F',
        last_name: 'L',
        status: 'ally',
        location: 'Loc',
        headline: 'Head',
        recent_activity: 'Act',
        messages: 5,
        conversion_likelihood: 'high',
        date_added: '2024-01-01T10:00:00.000Z',
        linkedin_url: 'https://linkedin.com',
        profile_picture_url: 'https://example.com/pic.jpg',
        common_interests: ['A', 123, ''],
        tags: ['T'],
        isFakeData: true,
      };
      const result = sanitizeConnectionData(raw);
      expect(result?.id).toBe('id1');
      expect(result?.status).toBe('ally');
      expect(result?.messages).toBe(5);
      expect(result?.common_interests).toEqual(['A']);
    });

    it('should handle strings that are too long', () => {
      const result = sanitizeConnectionData({
        id: '1',
        first_name: 'A'.repeat(200),
        status: 'ally',
        recent_activity: 'B'.repeat(3000),
      });
      expect(result?.first_name.length).toBe(100);
      expect(result?.recent_activity?.length).toBe(2000);
    });
  });

  describe('validateConnection', () => {
    it('should validate valid connection', () => {
      const conn = {
        id: '1',
        first_name: 'A',
        last_name: 'B',
        status: 'ally',
        position: 'P',
        company: 'C',
      };
      expect(validateConnection(conn).isValid).toBe(true);
    });

    it('should return error for invalid structure without sanitize', () => {
      const res = validateConnection({ id: '1' }, { sanitize: false });
      expect(res.isValid).toBe(false);
      expect(res.errors).toContain('Invalid connection object structure');
    });

    it('should warn and fix invalid structure with sanitize', () => {
      const res = validateConnection(
        { id: '1', first_name: 'A', last_name: 'B', status: 'new' },
        { sanitize: true }
      );
      expect(res.isValid).toBe(true);
      expect(res.warnings[0]).toContain('sanitized');
    });

    it('should fail if sanitization fails', () => {
      const res = validateConnection({ id: '1', status: 'alien' }, { sanitize: true });
      expect(res.isValid).toBe(false);
      expect(res.errors[0]).toContain('Unable to sanitize');
    });

    it('should handle validation issues as warnings for optional fields', () => {
      const conn = {
        id: '1',
        first_name: 'A',
        last_name: 'B',
        status: 'ally',
        position: 'P',
        company: 'C',
        location: 'A'.repeat(200), // too long
      };
      const res = validateConnection(conn);
      expect(res.isValid).toBe(true);
      expect(res.warnings.length).toBeGreaterThanOrEqual(1);
      expect(res.warnings.some((w) => w.includes('Location') || w.includes('Too big'))).toBe(true);
    });

    it('should handle multiple optional field issues', () => {
      const conn = {
        id: '1',
        first_name: 'A',
        last_name: 'B',
        status: 'ally',
        position: 'P',
        company: 'C',
        location: 'A'.repeat(200),
        headline: 'B'.repeat(1000),
        recent_activity: 'C'.repeat(3000),
        last_action_summary: 'D'.repeat(3000),
        date_added: 'invalid',
        linkedin_url: 'invalid',
        profile_picture_url: 'invalid',
      };
      const res = validateConnection(conn);
      expect(res.warnings.length).toBeGreaterThan(5);
    });
  });

  describe('validateMessage', () => {
    it('should validate valid message', () => {
      const msg = { id: '1', content: 'hi', timestamp: '2024-01-01T10:00:00.000Z', sender: 'user' };
      expect(validateMessage(msg).isValid).toBe(true);
    });

    it('should handle invalid message structure with sanitize', () => {
      const res = validateMessage({ content: 'hi' }, { sanitize: true });
      expect(res.isValid).toBe(false); // missing sender and timestamp even after sanitize
    });
  });

  describe('validateConnections', () => {
    it('should handle invalid input gracefully', () => {
      const raw = [
        { id: '1', first_name: 'A', last_name: 'B', status: 'ally', position: '', company: '' },
        null,
        { invalid: 'data' },
      ];
      // @ts-expect-error - testing invalid array with null
      const result = validateConnections(raw, { sanitize: true });
      expect(result.validConnections).toHaveLength(1);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });
  });
});
