import { describe, it, expect } from 'vitest';
import { filterConnections, sortConnections } from './connectionFiltering';
import type { Connection, ConnectionFilters } from '@/types';

const createConnection = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'conn-1',
  first_name: 'John',
  last_name: 'Doe',
  position: 'Engineer',
  company: 'Test Corp',
  status: 'ally',
  ...overrides,
});

describe('connectionFiltering', () => {
  describe('filterConnections', () => {
    it('should return all connections when no filters applied', () => {
      const connections = [createConnection(), createConnection({ id: 'conn-2' })];
      const result = filterConnections(connections, {});
      expect(result).toHaveLength(2);
    });

    it('should return empty array for empty input', () => {
      const result = filterConnections([], { status: 'ally' });
      expect(result).toEqual([]);
    });

    describe('status filter', () => {
      it('should filter by status', () => {
        const connections = [
          createConnection({ status: 'ally' }),
          createConnection({ id: 'conn-2', status: 'possible' }),
          createConnection({ id: 'conn-3', status: 'ally' }),
        ];
        const result = filterConnections(connections, { status: 'ally' });
        expect(result).toHaveLength(2);
        expect(result.every((c) => c.status === 'ally')).toBe(true);
      });

      it('should return all when status is "all"', () => {
        const connections = [
          createConnection({ status: 'ally' }),
          createConnection({ id: 'conn-2', status: 'possible' }),
        ];
        const result = filterConnections(connections, { status: 'all' });
        expect(result).toHaveLength(2);
      });
    });

    describe('search term filter', () => {
      it('should filter by first name', () => {
        const connections = [
          createConnection({ first_name: 'Alice' }),
          createConnection({ id: 'conn-2', first_name: 'Bob' }),
        ];
        const result = filterConnections(connections, { searchTerm: 'Alice' });
        expect(result).toHaveLength(1);
        expect(result[0].first_name).toBe('Alice');
      });

      it('should filter by company (case insensitive)', () => {
        const connections = [
          createConnection({ company: 'Tech Corp' }),
          createConnection({ id: 'conn-2', company: 'Other Inc' }),
        ];
        const result = filterConnections(connections, { searchTerm: 'tech' });
        expect(result).toHaveLength(1);
        expect(result[0].company).toBe('Tech Corp');
      });

      it('should filter by position', () => {
        const connections = [
          createConnection({ position: 'Software Engineer' }),
          createConnection({ id: 'conn-2', position: 'Designer' }),
        ];
        const result = filterConnections(connections, { searchTerm: 'engineer' });
        expect(result).toHaveLength(1);
      });
    });

    describe('location filter', () => {
      it('should filter by exact location', () => {
        const connections = [
          createConnection({ location: 'New York' }),
          createConnection({ id: 'conn-2', location: 'San Francisco' }),
        ];
        const result = filterConnections(connections, { location: 'New York' });
        expect(result).toHaveLength(1);
        expect(result[0].location).toBe('New York');
      });

      it('should exclude connections without location', () => {
        const connections = [
          createConnection({ location: 'New York' }),
          createConnection({ id: 'conn-2' }), // No location
        ];
        const result = filterConnections(connections, { location: 'New York' });
        expect(result).toHaveLength(1);
      });
    });

    describe('company filter', () => {
      it('should filter by exact company', () => {
        const connections = [
          createConnection({ company: 'Google' }),
          createConnection({ id: 'conn-2', company: 'Meta' }),
        ];
        const result = filterConnections(connections, { company: 'Google' });
        expect(result).toHaveLength(1);
        expect(result[0].company).toBe('Google');
      });
    });

    describe('conversion likelihood filter', () => {
      it('should filter by single conversion likelihood', () => {
        const connections = [
          createConnection({ conversion_likelihood: 'high' }),
          createConnection({ id: 'conn-2', conversion_likelihood: 'low' }),
          createConnection({ id: 'conn-3', conversion_likelihood: 'high' }),
        ];
        const result = filterConnections(connections, { conversionLikelihood: 'high' });
        expect(result).toHaveLength(2);
        expect(result.every((c) => c.conversion_likelihood === 'high')).toBe(true);
      });

      it('should filter by multiple conversion likelihoods', () => {
        const connections = [
          createConnection({ conversion_likelihood: 'high' }),
          createConnection({ id: 'conn-2', conversion_likelihood: 'low' }),
          createConnection({ id: 'conn-3', conversion_likelihood: 'medium' }),
        ];
        const result = filterConnections(connections, { conversionLikelihood: ['high', 'medium'] });
        expect(result).toHaveLength(2);
      });

      it('should return all when conversion likelihood is "all"', () => {
        const connections = [
          createConnection({ conversion_likelihood: 'high' }),
          createConnection({ id: 'conn-2', conversion_likelihood: 'low' }),
        ];
        const result = filterConnections(connections, { conversionLikelihood: 'all' });
        expect(result).toHaveLength(2);
      });

      it('should exclude connections without conversion likelihood', () => {
        const connections = [
          createConnection({ conversion_likelihood: 'high' }),
          createConnection({ id: 'conn-2' }), // No conversion_likelihood
        ];
        const result = filterConnections(connections, { conversionLikelihood: 'high' });
        expect(result).toHaveLength(1);
      });
    });

    describe('tags filter', () => {
      it('should filter by tags', () => {
        const connections = [
          createConnection({ tags: ['tech', 'startup'] }),
          createConnection({ id: 'conn-2', tags: ['finance'] }),
          createConnection({ id: 'conn-3', tags: ['tech'] }),
        ];
        const result = filterConnections(connections, { tags: ['tech'] });
        expect(result).toHaveLength(2);
      });

      it('should exclude connections without matching tags', () => {
        const connections = [
          createConnection({ tags: ['tech'] }),
          createConnection({ id: 'conn-2' }), // No tags
        ];
        const result = filterConnections(connections, { tags: ['tech'] });
        expect(result).toHaveLength(1);
      });
    });

    describe('combined filters', () => {
      it('should apply multiple filters together', () => {
        const connections = [
          createConnection({
            status: 'ally',
            location: 'New York',
            conversion_likelihood: 'high',
          }),
          createConnection({
            id: 'conn-2',
            status: 'possible',
            location: 'New York',
            conversion_likelihood: 'high',
          }),
          createConnection({
            id: 'conn-3',
            status: 'ally',
            location: 'San Francisco',
            conversion_likelihood: 'high',
          }),
        ];
        const filters: ConnectionFilters = {
          status: 'ally',
          location: 'New York',
        };
        const result = filterConnections(connections, filters);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('conn-1');
      });
    });
  });

  describe('sortConnections', () => {
    it('should sort by name ascending by default', () => {
      const connections = [
        createConnection({ first_name: 'Charlie' }),
        createConnection({ id: 'conn-2', first_name: 'Alice' }),
        createConnection({ id: 'conn-3', first_name: 'Bob' }),
      ];
      const result = sortConnections(connections);
      expect(result[0].first_name).toBe('Alice');
      expect(result[1].first_name).toBe('Bob');
      expect(result[2].first_name).toBe('Charlie');
    });

    it('should sort by name descending', () => {
      const connections = [
        createConnection({ first_name: 'Alice' }),
        createConnection({ id: 'conn-2', first_name: 'Charlie' }),
      ];
      const result = sortConnections(connections, 'name', 'desc');
      expect(result[0].first_name).toBe('Charlie');
      expect(result[1].first_name).toBe('Alice');
    });

    it('should sort by company', () => {
      const connections = [
        createConnection({ company: 'Zebra Inc' }),
        createConnection({ id: 'conn-2', company: 'Alpha Corp' }),
      ];
      const result = sortConnections(connections, 'company', 'asc');
      expect(result[0].company).toBe('Alpha Corp');
      expect(result[1].company).toBe('Zebra Inc');
    });

    it('should sort by date_added', () => {
      const connections = [
        createConnection({ date_added: '2024-01-15T00:00:00.000Z' }),
        createConnection({ id: 'conn-2', date_added: '2024-01-10T00:00:00.000Z' }),
      ];
      const result = sortConnections(connections, 'date_added', 'asc');
      expect(result[0].id).toBe('conn-2');
      expect(result[1].id).toBe('conn-1');
    });

    it('should sort by conversion_likelihood using ordinal values', () => {
      const connections = [
        createConnection({ conversion_likelihood: 'low' }),
        createConnection({ id: 'conn-2', conversion_likelihood: 'high' }),
        createConnection({ id: 'conn-3', conversion_likelihood: 'medium' }),
      ];
      const result = sortConnections(connections, 'conversion_likelihood', 'desc');
      expect(result[0].conversion_likelihood).toBe('high');
      expect(result[1].conversion_likelihood).toBe('medium');
      expect(result[2].conversion_likelihood).toBe('low');
    });

    it('should handle missing conversion_likelihood', () => {
      const connections = [
        createConnection({ conversion_likelihood: 'high' }),
        createConnection({ id: 'conn-2' }), // No conversion_likelihood
      ];
      const result = sortConnections(connections, 'conversion_likelihood', 'desc');
      expect(result[0].conversion_likelihood).toBe('high');
    });

    it('should sort by strength descending (highest first)', () => {
      const connections = [
        createConnection({ relationship_score: 30 }),
        createConnection({ id: 'conn-2', relationship_score: 90 }),
        createConnection({ id: 'conn-3', relationship_score: 60 }),
      ];
      const result = sortConnections(connections, 'strength', 'desc');
      expect(result[0].relationship_score).toBe(90);
      expect(result[1].relationship_score).toBe(60);
      expect(result[2].relationship_score).toBe(30);
    });

    it('should sort by strength ascending', () => {
      const connections = [
        createConnection({ relationship_score: 90 }),
        createConnection({ id: 'conn-2', relationship_score: 30 }),
      ];
      const result = sortConnections(connections, 'strength', 'asc');
      expect(result[0].relationship_score).toBe(30);
      expect(result[1].relationship_score).toBe(90);
    });

    it('should sort connections without relationship_score to the bottom', () => {
      const connections = [
        createConnection({ relationship_score: 50 }),
        createConnection({ id: 'conn-2' }), // No score
        createConnection({ id: 'conn-3', relationship_score: 80 }),
      ];
      const result = sortConnections(connections, 'strength', 'desc');
      expect(result[0].relationship_score).toBe(80);
      expect(result[1].relationship_score).toBe(50);
      expect(result[2].relationship_score).toBeUndefined();
    });

    it('should not mutate original array', () => {
      const connections = [
        createConnection({ first_name: 'Bob' }),
        createConnection({ id: 'conn-2', first_name: 'Alice' }),
      ];
      const original = [...connections];
      sortConnections(connections, 'name', 'asc');
      expect(connections).toEqual(original);
    });
  });
});
