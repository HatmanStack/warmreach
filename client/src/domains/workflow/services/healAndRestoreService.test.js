import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as healAndRestoreService from './healAndRestoreService.js';
import fs from 'fs/promises';

// Mock dependencies
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

describe('healAndRestoreService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authorizeHealAndRestore', () => {
    it('should authorize pending session', async () => {
      const mockSessions = {
        'session-123': { status: 'pending', timestamp: Date.now() },
      };
      fs.readFile.mockResolvedValue(JSON.stringify(mockSessions));
      fs.writeFile.mockResolvedValue(undefined);

      const result = await healAndRestoreService.authorizeHealAndRestore('session-123', true);

      expect(result).toBe(true);
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"status": "authorized"')
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"autoApprove": true')
      );
    });

    it('should return false if session not found', async () => {
      fs.readFile.mockResolvedValue('{}');
      const result = await healAndRestoreService.authorizeHealAndRestore('non-existent');
      expect(result).toBe(false);
    });

    it('should return false if session is not pending', async () => {
      const mockSessions = {
        'session-123': { status: 'authorized' },
      };
      fs.readFile.mockResolvedValue(JSON.stringify(mockSessions));
      const result = await healAndRestoreService.authorizeHealAndRestore('session-123');
      expect(result).toBe(false);
    });
  });

  describe('cancelHealAndRestore', () => {
    it('should cancel pending session', async () => {
      const mockSessions = {
        'session-123': { status: 'pending' },
      };
      fs.readFile.mockResolvedValue(JSON.stringify(mockSessions));
      fs.writeFile.mockResolvedValue(undefined);

      const result = await healAndRestoreService.cancelHealAndRestore('session-123');

      expect(result).toBe(true);
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"status": "cancelled"')
      );
    });
  });

  describe('getPendingAuthorizations', () => {
    it('should return list of pending sessions', async () => {
      const now = Date.now();
      const mockSessions = {
        s1: { status: 'pending', timestamp: now },
        s2: { status: 'authorized', timestamp: now },
        s3: { status: 'pending', timestamp: now - 1000 },
      };
      fs.readFile.mockResolvedValue(JSON.stringify(mockSessions));

      const pending = await healAndRestoreService.getPendingAuthorizations();

      expect(pending).toHaveLength(2);
      expect(pending).toContainEqual({ sessionId: 's1', timestamp: now });
      expect(pending).toContainEqual({ sessionId: 's3', timestamp: now - 1000 });
    });

    it('should return empty list if no sessions found', async () => {
      fs.readFile.mockRejectedValue(new Error('File not found'));
      const pending = await healAndRestoreService.getPendingAuthorizations();
      expect(pending).toEqual([]);
    });
  });
});
