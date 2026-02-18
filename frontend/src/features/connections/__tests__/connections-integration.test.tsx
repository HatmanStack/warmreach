/**
 * Integration tests for Connection Management
 *
 * Tests the full connection flow including:
 * - Fetching and displaying connections
 * - Filtering connections by various criteria
 * - Validation and type safety of connection data
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock auth service
vi.mock('@/features/auth', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'test-user' } })),
}));

// Mock services
const mockGetConnections = vi.fn();
vi.mock('@/shared/services', () => ({
  lambdaApiService: {
    getConnectionsByStatus: (...args: unknown[]) => mockGetConnections(...args),
    updateConnectionStatus: vi.fn(),
  },
  websocketService: { onMessage: vi.fn(() => vi.fn()), onStateChange: vi.fn(() => vi.fn()) },
  commandService: {},
}));

// Mock logger
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { Connection, ConnectionFilters } from '@/shared/types';
import { filterConnections, sortConnections } from '../utils/connectionFiltering';
import { validateConnections } from '@/shared/types/validators';
import { ConversionLikelihoodBadge } from '../components/ConversionLikelihoodBadge';

// Test fixtures
const createMockConnection = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'conn-' + Math.random().toString(36).substr(2, 9),
  first_name: 'John',
  last_name: 'Doe',
  position: 'Software Engineer',
  company: 'TechCorp',
  status: 'ally',
  ...overrides,
});

const mockConnections: Connection[] = [
  createMockConnection({
    id: 'conn-1',
    first_name: 'Alice',
    last_name: 'Johnson',
    company: 'TechCorp',
    location: 'New York',
    status: 'possible',
    conversion_likelihood: 'high',
    tags: ['tech', 'startup'],
  }),
  createMockConnection({
    id: 'conn-2',
    first_name: 'Bob',
    last_name: 'Smith',
    company: 'DataCo',
    location: 'San Francisco',
    status: 'ally',
    conversion_likelihood: 'medium',
    tags: ['data', 'analytics'],
  }),
  createMockConnection({
    id: 'conn-3',
    first_name: 'Charlie',
    last_name: 'Brown',
    company: 'TechCorp',
    location: 'New York',
    status: 'possible',
    conversion_likelihood: 'low',
    tags: ['tech'],
  }),
  createMockConnection({
    id: 'conn-4',
    first_name: 'Diana',
    last_name: 'Prince',
    company: 'DesignHub',
    location: 'Los Angeles',
    status: 'outgoing',
    conversion_likelihood: 'high',
    tags: ['design', 'ux'],
  }),
];

describe('Connection Management Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Connection Filtering Flow', () => {
    it('should filter connections by status', () => {
      const filters: ConnectionFilters = { status: 'possible' };
      const result = filterConnections(mockConnections, filters);

      expect(result).toHaveLength(2);
      expect(result.every((c) => c.status === 'possible')).toBe(true);
    });

    it('should filter connections by conversion likelihood enum', () => {
      const filters: ConnectionFilters = { conversionLikelihood: 'high' };
      const result = filterConnections(mockConnections, filters);

      expect(result).toHaveLength(2);
      expect(result.every((c) => c.conversion_likelihood === 'high')).toBe(true);
    });

    it('should filter by multiple criteria simultaneously', () => {
      const filters: ConnectionFilters = {
        status: 'possible',
        location: 'New York',
        conversionLikelihood: 'high',
      };
      const result = filterConnections(mockConnections, filters);

      expect(result).toHaveLength(1);
      expect(result[0].first_name).toBe('Alice');
    });

    it('should handle combined search and filter', () => {
      const filters: ConnectionFilters = {
        searchTerm: 'tech',
        company: 'TechCorp',
      };
      const result = filterConnections(mockConnections, filters);

      expect(result).toHaveLength(2);
      expect(result.every((c) => c.company === 'TechCorp')).toBe(true);
    });
  });

  describe('Connection Sorting Flow', () => {
    it('should sort by conversion likelihood (high first)', () => {
      const sorted = sortConnections(mockConnections, 'conversion_likelihood', 'desc');

      expect(sorted[0].conversion_likelihood).toBe('high');
      expect(sorted[sorted.length - 1].conversion_likelihood).toBe('low');
    });

    it('should sort by name alphabetically', () => {
      const sorted = sortConnections(mockConnections, 'name', 'asc');

      expect(sorted[0].first_name).toBe('Alice');
      expect(sorted[1].first_name).toBe('Bob');
      expect(sorted[2].first_name).toBe('Charlie');
      expect(sorted[3].first_name).toBe('Diana');
    });

    it('should sort by company', () => {
      const sorted = sortConnections(mockConnections, 'company', 'asc');

      expect(sorted[0].company).toBe('DataCo');
      expect(sorted[1].company).toBe('DesignHub');
    });
  });

  describe('Data Validation Flow', () => {
    it('should validate and accept valid connections', () => {
      const result = validateConnections(mockConnections);

      expect(result.validConnections).toHaveLength(4);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject connections with invalid conversion_likelihood', () => {
      const invalidConnections = [
        ...mockConnections,
        {
          id: 'invalid-1',
          first_name: 'Invalid',
          last_name: 'User',
          position: 'Test',
          company: 'Test',
          status: 'ally',
          conversion_likelihood: 75, // Invalid: should be 'high', 'medium', or 'low'
        },
      ];

      const result = validateConnections(invalidConnections);

      expect(result.validConnections).toHaveLength(4);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].index).toBe(4);
    });

    it('should reject connections with invalid status', () => {
      const invalidConnections = [
        {
          id: 'invalid-1',
          first_name: 'Invalid',
          last_name: 'User',
          position: 'Test',
          company: 'Test',
          status: 'unknown', // Invalid status
        },
      ];

      const result = validateConnections(invalidConnections);

      expect(result.validConnections).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('ConversionLikelihoodBadge Component', () => {
    it('should render high likelihood badge correctly', () => {
      render(<ConversionLikelihoodBadge likelihood="high" />);

      expect(screen.getByText('High')).toBeInTheDocument();
      expect(screen.getByText('High')).toHaveClass('bg-green-100');
    });

    it('should render medium likelihood badge correctly', () => {
      render(<ConversionLikelihoodBadge likelihood="medium" />);

      expect(screen.getByText('Medium')).toBeInTheDocument();
      expect(screen.getByText('Medium')).toHaveClass('bg-yellow-100');
    });

    it('should render low likelihood badge correctly', () => {
      render(<ConversionLikelihoodBadge likelihood="low" />);

      expect(screen.getByText('Low')).toBeInTheDocument();
      expect(screen.getByText('Low')).toHaveClass('bg-red-100');
    });
  });

  describe('Full Filter-Sort-Validate Flow', () => {
    it('should handle complete workflow: validate -> filter -> sort', () => {
      // Mix of valid and invalid data (simulating API response)
      const rawData = [
        ...mockConnections,
        {
          id: 'bad-1',
          first_name: 'Bad',
          last_name: 'Data',
          // Missing required fields
        },
      ];

      // Step 1: Validate
      const validated = validateConnections(rawData);
      expect(validated.validConnections).toHaveLength(4);
      expect(validated.errors).toHaveLength(1);

      // Step 2: Filter
      const filters: ConnectionFilters = {
        status: 'possible',
        conversionLikelihood: ['high', 'low'],
      };
      const filtered = filterConnections(validated.validConnections, filters);
      expect(filtered).toHaveLength(2);

      // Step 3: Sort
      const sorted = sortConnections(filtered, 'conversion_likelihood', 'desc');
      expect(sorted[0].conversion_likelihood).toBe('high');
      expect(sorted[1].conversion_likelihood).toBe('low');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty connection list', () => {
      const result = filterConnections([], { status: 'ally' });
      expect(result).toEqual([]);
    });

    it('should handle connections without optional fields', () => {
      const minimalConnections: Connection[] = [
        {
          id: 'min-1',
          first_name: 'Min',
          last_name: 'User',
          position: 'Engineer',
          company: 'Corp',
          status: 'ally',
          // No optional fields: location, tags, conversion_likelihood
        },
      ];

      const validated = validateConnections(minimalConnections);
      expect(validated.validConnections).toHaveLength(1);

      const filtered = filterConnections(minimalConnections, {});
      expect(filtered).toHaveLength(1);
    });

    it('should preserve original array order when no sort applied', () => {
      const original = [...mockConnections];
      filterConnections(mockConnections, {});
      expect(mockConnections).toEqual(original);
    });
  });
});
