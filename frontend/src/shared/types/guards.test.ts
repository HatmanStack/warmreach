import { describe, it, expect } from 'vitest';
import {
  isNonEmptyString,
  isConnectionStatus,
  isMessageSender,
  isValidISODate,
  isValidUrl,
  isPositiveInteger,
  isConnection,
  isMessage,
  isProgressState,
  isTierInfo,
  isApiResponse,
  isConnectionFilters,
} from './guards';

describe('Guards', () => {
  describe('isNonEmptyString', () => {
    it('should return true for valid non-empty strings', () => {
      expect(isNonEmptyString('a')).toBe(true);
      expect(isNonEmptyString(' ')).toBe(true);
    });

    it('should return false for empty strings or non-strings', () => {
      expect(isNonEmptyString('')).toBe(false);
      expect(isNonEmptyString(null)).toBe(false);
      expect(isNonEmptyString(undefined)).toBe(false);
      expect(isNonEmptyString(123)).toBe(false);
    });
  });

  describe('isConnectionStatus', () => {
    it('should validate connection statuses', () => {
      expect(isConnectionStatus('ally')).toBe(true);
      expect(isConnectionStatus('possible')).toBe(true);
      expect(isConnectionStatus('incoming')).toBe(true);
      expect(isConnectionStatus('outgoing')).toBe(true);
      expect(isConnectionStatus('processed')).toBe(true);
      expect(isConnectionStatus('unknown')).toBe(false);
      expect(isConnectionStatus(null)).toBe(false);
    });
  });

  describe('isMessageSender', () => {
    it('should validate message senders', () => {
      expect(isMessageSender('user')).toBe(true);
      expect(isMessageSender('connection')).toBe(true);
      expect(isMessageSender('other')).toBe(false);
    });
  });

  describe('isValidISODate', () => {
    it('should validate ISO dates strictly', () => {
      expect(isValidISODate('2024-01-01T10:00:00.000Z')).toBe(true);
      expect(isValidISODate('2024-01-01')).toBe(false); // not full ISO
      expect(isValidISODate('not-a-date')).toBe(false);
      expect(isValidISODate(null)).toBe(false);
    });
  });

  describe('isValidUrl', () => {
    it('should validate URLs', () => {
      expect(isValidUrl('https://google.com')).toBe(true);
      expect(isValidUrl('invalid')).toBe(false);
      expect(isValidUrl('')).toBe(false);
    });
  });

  describe('isPositiveInteger', () => {
    it('should validate positive integers', () => {
      expect(isPositiveInteger(5)).toBe(true);
      expect(isPositiveInteger(0)).toBe(false);
      expect(isPositiveInteger(-1)).toBe(false);
      expect(isPositiveInteger(5.5)).toBe(false);
      expect(isPositiveInteger('5')).toBe(false);
    });
  });

  describe('isConnection', () => {
    it('should validate connection objects strictly', () => {
      const valid = {
        id: 'c1',
        first_name: 'J',
        last_name: 'D',
        status: 'ally',
        position: 'E',
        company: 'T',
      };
      expect(isConnection(valid)).toBe(true);
      expect(isConnection({ ...valid, status: 'invalid' })).toBe(false);
      expect(isConnection({ ...valid, id: 123 })).toBe(false);
      expect(isConnection(null)).toBe(false);
    });

    it('should handle optional fields and nested validation', () => {
      const conn = {
        id: 'c1',
        first_name: 'J',
        last_name: 'D',
        status: 'ally',
        position: 'E',
        company: 'T',
        location: 123, // invalid type
      };
      expect(isConnection(conn)).toBe(false);

      const validWithNest = {
        id: 'c1',
        first_name: 'J',
        last_name: 'D',
        status: 'ally',
        position: 'E',
        company: 'T',
        message_history: [
          { id: 'm1', content: 'hi', timestamp: '2024-01-01T10:00:00.000Z', sender: 'user' },
        ],
      };
      expect(isConnection(validWithNest)).toBe(true);

      const invalidNest = {
        ...validWithNest,
        message_history: [{ invalid: 'msg' }],
      };
      expect(isConnection(invalidNest)).toBe(false);
    });
  });

  describe('isMessage', () => {
    it('should validate message objects', () => {
      const valid = {
        id: 'm1',
        content: 'hi',
        timestamp: '2024-01-01T10:00:00.000Z',
        sender: 'user',
      };
      expect(isMessage(valid)).toBe(true);
      expect(isMessage({ ...valid, sender: 'other' })).toBe(false);
      expect(isMessage({})).toBe(false);
    });
  });

  describe('isProgressState', () => {
    it('should validate progress state', () => {
      const valid = { total: 10, current: 5, phase: 'generating' };
      expect(isProgressState(valid)).toBe(true);
      expect(isProgressState({ ...valid, total: '10' })).toBe(false);
    });
  });

  describe('isTierInfo', () => {
    it('should validate tier info', () => {
      const valid = { tier: 'pro', features: {}, quotas: {} };
      expect(isTierInfo(valid)).toBe(true);
      expect(isTierInfo(null)).toBe(false);
    });
  });

  describe('isApiResponse', () => {
    it('should validate API responses', () => {
      const valid = { statusCode: 200, body: { ok: true } };
      expect(isApiResponse(valid)).toBe(true);
      expect(isApiResponse({ body: {} })).toBe(false); // missing status
      expect(isApiResponse({ ...valid, statusCode: '200' })).toBe(false);
    });

    it('should use body validator', () => {
      const valid = { statusCode: 200, body: { count: 5 } };
      const validator = (body: any): body is { count: number } => typeof body.count === 'number';
      expect(isApiResponse(valid, validator)).toBe(true);
      expect(isApiResponse({ ...valid, body: { count: '5' } }, validator)).toBe(false);
    });
  });

  describe('isConnectionFilters', () => {
    it('should validate filter objects', () => {
      expect(isConnectionFilters({})).toBe(true);
      expect(isConnectionFilters({ status: 'ally' })).toBe(true);
      expect(isConnectionFilters({ status: 'all' })).toBe(true);
      expect(isConnectionFilters({ status: 'invalid' })).toBe(false);
      expect(isConnectionFilters({ tags: ['T1'] })).toBe(true);
      expect(isConnectionFilters({ tags: 'T1' })).toBe(false);
    });
  });
});
