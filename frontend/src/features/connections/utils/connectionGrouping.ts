import type { Connection } from '@/types';
import { sortConnections } from './connectionFiltering';

/**
 * A group of "possible" connections that were surfaced by the same LinkedIn
 * search run — identified by the company / role / location the search filtered
 * on (their edge provenance). Connections with no provenance (found before
 * provenance was recorded) collapse into a single trailing "ungrouped" bucket.
 */
export interface ConnectionRunGroup {
  /** Stable key for React lists and expand/collapse state. */
  key: string;
  /** Human-readable header, e.g. "Amazon · Software · Seattle". */
  label: string;
  /** Normalized search terms (may be empty strings for the ungrouped bucket). */
  company: string;
  role: string;
  location: string;
  /** Most-recent date_added within the group (ISO string, '' if none). */
  latestDate: string;
  /** Connections in the group, pre-sorted. */
  connections: Connection[];
  count: number;
  /** True for the trailing "Earlier connections (no search source)" bucket. */
  isUngrouped: boolean;
}

const UNGROUPED_KEY = '__no_source__';

/** Title-case a lowercased provenance term ("software" -> "Software"). */
function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** A connection carries search provenance if any of the three fields is set. */
function hasSource(connection: Connection): boolean {
  return Boolean(
    connection.source_company?.trim() ||
    connection.source_role?.trim() ||
    connection.source_location?.trim()
  );
}

/** Build the grouping key from a connection's normalized provenance triple. */
function sourceKey(connection: Connection): string {
  const company = (connection.source_company ?? '').trim().toLowerCase();
  const role = (connection.source_role ?? '').trim().toLowerCase();
  const location = (connection.source_location ?? '').trim().toLowerCase();
  return `${company}|${role}|${location}`;
}

/**
 * Group "possible" connections by the search run that surfaced them.
 *
 * Grouping is by the search terms (company + role + location), NOT by date:
 * re-running the same search preserves each contact's original `addedAt`, so a
 * date-bucketed grouping would scatter one logical search across several days.
 * Groups are ordered by most-recent find; the ungrouped bucket sorts last.
 *
 * @param connections - Connections to group (caller filters to 'possible' first).
 * @returns Ordered run groups, each with connections sorted by the given key.
 */
export function groupConnectionsByRun(
  connections: Connection[],
  sortBy:
    | 'name'
    | 'company'
    | 'date_added'
    | 'conversion_likelihood'
    | 'strength' = 'conversion_likelihood',
  sortOrder: 'asc' | 'desc' = 'desc'
): ConnectionRunGroup[] {
  const buckets = new Map<string, Connection[]>();

  for (const connection of connections) {
    const key = hasSource(connection) ? sourceKey(connection) : UNGROUPED_KEY;
    const existing = buckets.get(key);
    if (existing) {
      existing.push(connection);
    } else {
      buckets.set(key, [connection]);
    }
  }

  const groups: ConnectionRunGroup[] = [];
  for (const [key, groupConnections] of buckets.entries()) {
    const isUngrouped = key === UNGROUPED_KEY;
    const first = groupConnections[0];
    const company = isUngrouped ? '' : (first?.source_company ?? '').trim();
    const role = isUngrouped ? '' : (first?.source_role ?? '').trim();
    const location = isUngrouped ? '' : (first?.source_location ?? '').trim();

    const latestDate = groupConnections.reduce((latest, c) => {
      const d = c.date_added ?? '';
      return d > latest ? d : latest;
    }, '');

    const label = isUngrouped
      ? 'Earlier connections (no search source)'
      : [company, role, location].filter(Boolean).map(titleCase).join(' · ') || 'Untitled search';

    groups.push({
      key,
      label,
      company,
      role,
      location,
      latestDate,
      connections: sortConnections(groupConnections, sortBy, sortOrder),
      count: groupConnections.length,
      isUngrouped,
    });
  }

  // Most-recent search first; the "no source" bucket always trails.
  groups.sort((a, b) => {
    if (a.isUngrouped !== b.isUngrouped) return a.isUngrouped ? 1 : -1;
    return b.latestDate.localeCompare(a.latestDate);
  });

  return groups;
}
