import { describe, it, expect } from 'vitest';
import { connectionDataContextService } from './connectionDataContextService';
import { buildConnection, buildUserProfile } from '@/test-utils';

describe('ConnectionDataContextService', () => {
  const mockConnection = buildConnection({
    id: 'c1',
    first_name: 'John',
    last_name: 'Doe',
    message_history: [
      { id: 'm1', content: 'Hi', timestamp: '2024-01-01T10:00:00.000Z', sender: 'connection' },
    ],
    tags: ['T1'],
    common_interests: ['Coding'],
  });

  const mockProfile = buildUserProfile({
    user_id: 'u1',
    interests: ['Coding', 'Music'],
  });

  describe('prepareMessageGenerationContext', () => {
    it('should prepare full context', () => {
      const context = connectionDataContextService.prepareMessageGenerationContext(
        mockConnection,
        'Project Alpha',
        mockProfile
      );

      expect(context.connection.id).toBe('c1');
      expect(context.topic).toBe('Project Alpha');
      expect(context.messageHistory).toHaveLength(1);
      expect(context.userProfile.user_id).toBe('u1');
    });

    it('should handle missing options', () => {
      const context = connectionDataContextService.prepareMessageGenerationContext(
        mockConnection,
        'Topic'
      );
      expect(context.userProfile).toEqual({});
    });
  });

  describe('prepareConversationTopic', () => {
    it('should clean and normalize topic', () => {
      expect(connectionDataContextService.prepareConversationTopic('  Some   Topic  ')).toBe(
        'Some Topic'
      );
    });

    it('should throw on empty topic', () => {
      expect(() => connectionDataContextService.prepareConversationTopic('')).toThrow();
      // @ts-expect-error - testing invalid null input
      expect(() => connectionDataContextService.prepareConversationTopic(null)).toThrow();
    });
  });

  describe('prepareConnectionTags', () => {
    it('should combine tags and interests and remove duplicates', () => {
      const conn = buildConnection({
        tags: ['Tag1', 'Common'],
        common_interests: ['Interest1', 'Common'],
      });
      const tags = connectionDataContextService.prepareConnectionTags(conn);
      expect(tags).toContain('Tag1');
      expect(tags).toContain('Interest1');
      expect(tags).toContain('Common');
      expect(tags).toHaveLength(3);
    });
  });

  describe('findCommonInterests', () => {
    it('should find common interests case-insensitively', () => {
      const profile = buildUserProfile({ interests: ['CODING', 'MUSIC'] });
      const conn = buildConnection({ common_interests: ['coding', 'sports'] });
      const common = connectionDataContextService.findCommonInterests(profile, conn);
      expect(common).toEqual(['coding']);
    });
  });

  describe('prepareConnectionNotes', () => {
    it('should return sorted notes by timestamp descending', () => {
      const conn = buildConnection({
        notes: [
          {
            id: 'n1',
            content: 'First',
            timestamp: '2024-01-01T10:00:00Z',
            updatedAt: '2024-01-01T10:00:00Z',
          },
          {
            id: 'n2',
            content: 'Second',
            timestamp: '2024-06-01T10:00:00Z',
            updatedAt: '2024-06-01T10:00:00Z',
          },
          {
            id: 'n3',
            content: 'Third',
            timestamp: '2024-03-01T10:00:00Z',
            updatedAt: '2024-03-01T10:00:00Z',
          },
        ],
      });
      const notes = connectionDataContextService.prepareConnectionNotes(conn);
      expect(notes[0].id).toBe('n2');
      expect(notes[1].id).toBe('n3');
      expect(notes[2].id).toBe('n1');
    });

    it('should return empty array when no notes', () => {
      const conn = buildConnection({ notes: undefined });
      expect(connectionDataContextService.prepareConnectionNotes(conn)).toEqual([]);
    });

    it('should return empty array when notes is empty', () => {
      const conn = buildConnection({ notes: [] });
      expect(connectionDataContextService.prepareConnectionNotes(conn)).toEqual([]);
    });

    it('should respect maxNotes limit', () => {
      const conn = buildConnection({
        notes: Array.from({ length: 30 }, (_, i) => ({
          id: `n${i}`,
          content: `Note ${i}`,
          timestamp: `2024-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
          updatedAt: `2024-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
        })),
      });
      const notes = connectionDataContextService.prepareConnectionNotes(conn, 5);
      expect(notes).toHaveLength(5);
    });
  });

  describe('prepareMessageGenerationContext with notes', () => {
    it('should include notes by default', () => {
      const conn = buildConnection({
        notes: [
          {
            id: 'n1',
            content: 'A note',
            timestamp: '2024-01-01T10:00:00Z',
            updatedAt: '2024-01-01T10:00:00Z',
          },
        ],
      });
      const context = connectionDataContextService.prepareMessageGenerationContext(conn, 'Topic');
      expect(context.connectionNotes).toHaveLength(1);
    });

    it('should exclude notes when includeNotes is false', () => {
      const conn = buildConnection({
        notes: [
          {
            id: 'n1',
            content: 'A note',
            timestamp: '2024-01-01T10:00:00Z',
            updatedAt: '2024-01-01T10:00:00Z',
          },
        ],
      });
      const context = connectionDataContextService.prepareMessageGenerationContext(
        conn,
        'Topic',
        undefined,
        { includeNotes: false }
      );
      expect(context.connectionNotes).toHaveLength(0);
    });
  });

  describe('calculateContextRelevance', () => {
    it('should calculate a score based on available data', () => {
      const context = connectionDataContextService.prepareMessageGenerationContext(
        mockConnection,
        'A very long topic string for better score',
        mockProfile
      );
      const score = connectionDataContextService.calculateContextRelevance(context);
      expect(score).toBeGreaterThan(0.5);
    });

    it('should give bonus for notes', () => {
      const connWithNotes = buildConnection({
        ...mockConnection,
        notes: [
          {
            id: 'n1',
            content: 'A note',
            timestamp: '2024-01-01T10:00:00Z',
            updatedAt: '2024-01-01T10:00:00Z',
          },
        ],
      });
      const contextWithNotes = connectionDataContextService.prepareMessageGenerationContext(
        connWithNotes,
        'A very long topic string for better score',
        mockProfile
      );
      const contextWithoutNotes = connectionDataContextService.prepareMessageGenerationContext(
        mockConnection,
        'A very long topic string for better score',
        mockProfile
      );
      const scoreWith = connectionDataContextService.calculateContextRelevance(contextWithNotes);
      const scoreWithout =
        connectionDataContextService.calculateContextRelevance(contextWithoutNotes);
      expect(scoreWith).toBeGreaterThan(scoreWithout);
    });
  });
});
