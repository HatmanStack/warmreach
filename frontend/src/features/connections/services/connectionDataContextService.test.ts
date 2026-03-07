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
  });
});
