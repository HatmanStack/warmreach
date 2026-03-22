import { describe, it, expect } from 'vitest';
import { escapeCsvValue, buildConnectionsCsvContent } from './csvExport';
import { buildConnection } from '@/test-utils';

describe('escapeCsvValue', () => {
  it('should pass through simple string', () => {
    expect(escapeCsvValue('hello')).toBe('hello');
  });

  it('should wrap string with comma in double quotes', () => {
    expect(escapeCsvValue('hello, world')).toBe('"hello, world"');
  });

  it('should escape double quotes and wrap', () => {
    expect(escapeCsvValue('say "hello"')).toBe('"say ""hello"""');
  });

  it('should wrap string with newline', () => {
    expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"');
  });

  it('should return empty string for undefined', () => {
    expect(escapeCsvValue(undefined)).toBe('');
  });

  it('should return empty string for null', () => {
    expect(escapeCsvValue(null)).toBe('');
  });

  it('should convert number to string', () => {
    expect(escapeCsvValue(42)).toBe('42');
  });
});

describe('buildConnectionsCsvContent', () => {
  it('should include base fields in output', () => {
    const connections = [
      buildConnection({
        first_name: 'John',
        last_name: 'Doe',
        company: 'Acme',
        position: 'Engineer',
        location: 'NY',
        status: 'ally',
        date_added: '2024-01-01',
        messages: 5,
      }),
    ];

    const content = buildConnectionsCsvContent(connections);

    expect(content).toContain('Name,Company,Position,Location,Status,Date Added');
    expect(content).toContain('John Doe,Acme,Engineer,NY,ally,2024-01-01');
    expect(content).not.toContain('Relationship Score');
  });

  it('should exclude Pro fields when includeProFields is false', () => {
    const content = buildConnectionsCsvContent([buildConnection()], { includeProFields: false });

    expect(content).not.toContain('Relationship Score');
    expect(content).not.toContain('Score - Frequency');
  });

  it('should include Pro fields when includeProFields is true', () => {
    const connections = [
      buildConnection({
        relationship_score: 85,
        score_breakdown: {
          frequency: 0.8,
          recency: 0.9,
          reciprocity: 0.7,
          profile_completeness: 0.95,
          depth: 0.6,
        },
      }),
    ];

    const content = buildConnectionsCsvContent(connections, { includeProFields: true });

    expect(content).toContain('Relationship Score');
    expect(content).toContain('Score - Frequency');
    expect(content).toContain('85');
    expect(content).toContain('0.8');
  });

  it('should handle empty connections array (header-only CSV)', () => {
    const content = buildConnectionsCsvContent([]);

    const lines = content.split('\r\n');
    expect(lines).toHaveLength(1); // header only
    expect(lines[0]).toContain('Name');
  });

  it('should include message count from messages field', () => {
    const connections = [buildConnection({ messages: 10 })];
    const content = buildConnectionsCsvContent(connections);
    expect(content).toContain('10');
  });

  it('should use message_history length as fallback for message count', () => {
    const connections = [
      buildConnection({
        messages: undefined,
        message_history: [
          { id: 'm1', content: 'Hi', timestamp: '2024-01-01T10:00:00Z', sender: 'user' },
          { id: 'm2', content: 'Hello', timestamp: '2024-01-02T10:00:00Z', sender: 'connection' },
        ],
      }),
    ];
    const content = buildConnectionsCsvContent(connections);
    expect(content).toContain(',2'); // message count
  });

  it('should include last message date from message_history', () => {
    const connections = [
      buildConnection({
        message_history: [
          { id: 'm1', content: 'Hi', timestamp: '2024-01-01T10:00:00Z', sender: 'user' },
          { id: 'm2', content: 'Hello', timestamp: '2024-06-15T10:00:00Z', sender: 'connection' },
        ],
      }),
    ];
    const content = buildConnectionsCsvContent(connections);
    expect(content).toContain('2024-06-15T10:00:00Z');
  });
});
