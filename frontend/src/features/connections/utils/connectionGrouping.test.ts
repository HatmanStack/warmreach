import { describe, it, expect } from 'vitest';
import { groupConnectionsByRun } from './connectionGrouping';
import type { Connection } from '@/types';

const createConnection = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'conn-1',
  first_name: 'John',
  last_name: 'Doe',
  position: 'Engineer',
  company: 'Test Corp',
  status: 'possible',
  ...overrides,
});

describe('groupConnectionsByRun', () => {
  it('returns an empty array for no connections', () => {
    expect(groupConnectionsByRun([])).toEqual([]);
  });

  it('groups connections by their search-term provenance', () => {
    const connections = [
      createConnection({
        id: 'a',
        source_company: 'amazon',
        source_role: 'software',
        source_location: 'seattle',
      }),
      createConnection({
        id: 'b',
        source_company: 'amazon',
        source_role: 'software',
        source_location: 'seattle',
      }),
      createConnection({
        id: 'c',
        source_company: 'microsoft',
        source_role: 'software',
        source_location: 'seattle',
      }),
    ];

    const groups = groupConnectionsByRun(connections);
    expect(groups).toHaveLength(2);
    const amazon = groups.find((g) => g.company === 'amazon');
    expect(amazon?.count).toBe(2);
    expect(amazon?.connections.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('normalizes case/whitespace so the same search groups together', () => {
    const connections = [
      createConnection({ id: 'a', source_company: 'Amazon', source_role: 'Software' }),
      createConnection({ id: 'b', source_company: 'amazon ', source_role: ' software' }),
    ];
    const groups = groupConnectionsByRun(connections);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
  });

  it('builds a title-cased label from the provenance triple', () => {
    const groups = groupConnectionsByRun([
      createConnection({
        source_company: 'amazon',
        source_role: 'software',
        source_location: 'seattle',
      }),
    ]);
    expect(groups[0].label).toBe('Amazon · Software · Seattle');
  });

  it('omits blank provenance parts from the label', () => {
    const groups = groupConnectionsByRun([
      createConnection({ source_company: 'amazon', source_role: '', source_location: 'seattle' }),
    ]);
    expect(groups[0].label).toBe('Amazon · Seattle');
  });

  it('collapses connections with no provenance into a trailing ungrouped bucket', () => {
    const connections = [
      createConnection({
        id: 'sourced',
        source_company: 'amazon',
        date_added: '2026-07-15T00:00:00Z',
      }),
      createConnection({ id: 'legacy-1' }),
      createConnection({ id: 'legacy-2' }),
    ];
    const groups = groupConnectionsByRun(connections);
    expect(groups).toHaveLength(2);
    // Ungrouped bucket is always last.
    const last = groups[groups.length - 1];
    expect(last.isUngrouped).toBe(true);
    expect(last.count).toBe(2);
    expect(last.label).toBe('Earlier connections (no search source)');
  });

  it('orders groups by most-recent find, ungrouped last', () => {
    const connections = [
      createConnection({ id: 'old', source_company: 'apple', date_added: '2026-06-01T00:00:00Z' }),
      createConnection({
        id: 'new',
        source_company: 'amazon',
        date_added: '2026-07-15T00:00:00Z',
      }),
      createConnection({ id: 'legacy', date_added: '2026-07-20T00:00:00Z' }),
    ];
    const groups = groupConnectionsByRun(connections);
    expect(groups.map((g) => g.company)).toEqual(['amazon', 'apple', '']);
    // Even though the legacy contact has the newest date_added, it trails.
    expect(groups[groups.length - 1].isUngrouped).toBe(true);
  });

  it('sorts connections within a group by conversion likelihood by default', () => {
    const connections = [
      createConnection({ id: 'low', source_company: 'amazon', conversion_likelihood: 'low' }),
      createConnection({ id: 'high', source_company: 'amazon', conversion_likelihood: 'high' }),
      createConnection({ id: 'med', source_company: 'amazon', conversion_likelihood: 'medium' }),
    ];
    const groups = groupConnectionsByRun(connections);
    expect(groups[0].connections.map((c) => c.id)).toEqual(['high', 'med', 'low']);
  });
});
