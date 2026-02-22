import type { Connection, ConnectionFilters, ConversionLikelihood } from '@/types';

/**
 * Ordinal values for conversion likelihood enum sorting
 * Higher value = higher priority in descending sort
 */
const LIKELIHOOD_ORDINAL: Record<ConversionLikelihood, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Filters connections based on the provided filter criteria
 *
 * @param connections - Array of connections to filter
 * @param filters - Filter criteria to apply
 * @returns Filtered array of connections
 */
export function filterConnections(
  connections: Connection[],
  filters: ConnectionFilters
): Connection[] {
  if (!connections.length) return connections;

  return connections.filter((connection) => {
    // Status filter
    if (filters.status && filters.status !== 'all') {
      if (connection.status !== filters.status) {
        return false;
      }
    }

    // Search term filter (searches name, position, company, headline)
    if (filters.searchTerm) {
      const searchTerm = filters.searchTerm.toLowerCase().trim();
      if (searchTerm) {
        const searchableText = [
          connection.first_name,
          connection.last_name,
          connection.position,
          connection.company,
          connection.headline || '',
          connection.location || '',
        ]
          .join(' ')
          .toLowerCase();

        if (!searchableText.includes(searchTerm)) {
          return false;
        }
      }
    }

    // Location filter
    if (filters.location) {
      if (!connection.location || connection.location !== filters.location) {
        return false;
      }
    }

    // Company filter
    if (filters.company) {
      if (!connection.company || connection.company !== filters.company) {
        return false;
      }
    }

    // Conversion likelihood filter
    if (filters.conversionLikelihood && filters.conversionLikelihood !== 'all') {
      const likelihood = connection.conversion_likelihood;

      // If connection doesn't have conversion likelihood, exclude it
      if (!likelihood) {
        return false;
      }

      // Handle single value or array of values
      const allowedValues = Array.isArray(filters.conversionLikelihood)
        ? filters.conversionLikelihood
        : [filters.conversionLikelihood];

      if (!allowedValues.includes(likelihood)) {
        return false;
      }
    }

    // Tags filter
    if (filters.tags && filters.tags.length > 0) {
      const connectionTags = connection.tags || [];
      const hasMatchingTag = filters.tags.some((filterTag) => connectionTags.includes(filterTag));

      if (!hasMatchingTag) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Sorts connections based on various criteria
 *
 * @param connections - Array of connections to sort
 * @param sortBy - Field to sort by
 * @param sortOrder - Sort direction
 * @returns Sorted array of connections
 */
export function sortConnections(
  connections: Connection[],
  sortBy: 'name' | 'company' | 'date_added' | 'conversion_likelihood' | 'strength' = 'name',
  sortOrder: 'asc' | 'desc' = 'asc'
): Connection[] {
  const sorted = [...connections].sort((a, b) => {
    let aValue: string | number | Date;
    let bValue: string | number | Date;

    switch (sortBy) {
      case 'name':
        aValue = `${a.first_name} ${a.last_name}`.toLowerCase();
        bValue = `${b.first_name} ${b.last_name}`.toLowerCase();
        break;

      case 'company':
        aValue = a.company.toLowerCase();
        bValue = b.company.toLowerCase();
        break;

      case 'date_added':
        aValue = new Date(a.date_added || '1970-01-01');
        bValue = new Date(b.date_added || '1970-01-01');
        break;

      case 'conversion_likelihood':
        // Use ordinal values for enum-based sorting
        aValue = a.conversion_likelihood ? LIKELIHOOD_ORDINAL[a.conversion_likelihood] : 0;
        bValue = b.conversion_likelihood ? LIKELIHOOD_ORDINAL[b.conversion_likelihood] : 0;
        break;

      case 'strength':
        aValue = a.relationship_score ?? -1;
        bValue = b.relationship_score ?? -1;
        break;

      default:
        aValue = `${a.first_name} ${a.last_name}`.toLowerCase();
        bValue = `${b.first_name} ${b.last_name}`.toLowerCase();
    }

    if (aValue < bValue) {
      return sortOrder === 'asc' ? -1 : 1;
    }
    if (aValue > bValue) {
      return sortOrder === 'asc' ? 1 : -1;
    }
    return 0;
  });

  return sorted;
}
