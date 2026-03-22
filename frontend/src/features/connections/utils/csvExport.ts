import type { Connection } from '@/shared/types';

/**
 * Escape a value for safe inclusion in a CSV cell.
 * Wraps in double quotes if the value contains commas, double quotes, or newlines.
 * Doubles any existing double quotes per RFC 4180.
 */
export function escapeCsvValue(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build CSV content string from connections data.
 * Exported for testability.
 */
export function buildConnectionsCsvContent(
  connections: Connection[],
  options: { includeProFields?: boolean } = {}
): string {
  const { includeProFields = false } = options;

  const baseHeaders = [
    'Name',
    'Company',
    'Position',
    'Location',
    'Status',
    'Date Added',
    'Last Message Date',
    'Message Count',
  ];

  const proHeaders = [
    'Relationship Score',
    'Score - Frequency',
    'Score - Recency',
    'Score - Reciprocity',
    'Score - Profile Completeness',
    'Score - Depth',
  ];

  const headers = includeProFields ? [...baseHeaders, ...proHeaders] : baseHeaders;

  const rows = connections.map((conn) => {
    const lastMessageDate =
      conn.message_history && conn.message_history.length > 0
        ? conn.message_history[conn.message_history.length - 1].timestamp
        : '';

    const messageCount = conn.messages ?? conn.message_history?.length ?? 0;

    const baseValues = [
      escapeCsvValue(`${conn.first_name} ${conn.last_name}`),
      escapeCsvValue(conn.company),
      escapeCsvValue(conn.position),
      escapeCsvValue(conn.location),
      escapeCsvValue(conn.status),
      escapeCsvValue(conn.date_added),
      escapeCsvValue(lastMessageDate),
      escapeCsvValue(messageCount),
    ];

    if (includeProFields) {
      const proValues = [
        escapeCsvValue(conn.relationship_score),
        escapeCsvValue(conn.score_breakdown?.frequency),
        escapeCsvValue(conn.score_breakdown?.recency),
        escapeCsvValue(conn.score_breakdown?.reciprocity),
        escapeCsvValue(conn.score_breakdown?.profile_completeness),
        escapeCsvValue(conn.score_breakdown?.depth),
      ];
      return [...baseValues, ...proValues].join(',');
    }

    return baseValues.join(',');
  });

  return [headers.join(','), ...rows].join('\r\n');
}

/**
 * Export connections data as a CSV file download.
 */
export function exportConnectionsCsv(
  connections: Connection[],
  options: { includeProFields?: boolean } = {}
): void {
  const csvContent = buildConnectionsCsvContent(connections, options);

  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `warmreach-connections-${dateStr}.csv`;

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
