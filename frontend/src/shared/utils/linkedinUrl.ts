/**
 * Shared LinkedIn URL building utility.
 *
 * Extracts and normalizes LinkedIn profile URLs from various input formats:
 * explicit URLs, vanity slugs, base64-encoded IDs, or falls back to people search.
 */

export interface LinkedInProfileInput {
  linkedin_url?: string;
  id?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

// This regex could match short base64 strings, but that's acceptable because
// the linkedin_url field is expected to contain URLs or vanity slugs, not base64.
// Base64-encoded IDs are only stored in the `id` field, which is handled
// separately via decodeBase64UrlSafe.
export function isVanitySlug(value: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(value);
}

export function decodeBase64UrlSafe(value: string): string | null {
  try {
    // Normalize URL-safe base64 to standard base64 and add padding
    let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    if (pad === 2) normalized += '==';
    if (pad === 3) normalized += '=';
    const decoded = atob(normalized);
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Build a LinkedIn profile URL from a connection-like object.
 *
 * Resolution order:
 * 1. Explicit `linkedin_url` (full HTTP URL, `in/vanity` format, or bare vanity slug)
 * 2. Base64-decoded `id` field (URL-safe base64 -> decoded URL or vanity)
 * 3. Fallback to people search with name + company
 *
 * Returns null when no data is available.
 */
export function buildLinkedInProfileUrl(connection: LinkedInProfileInput): string | null {
  // 1) Prefer explicit linkedin_url when present
  const rawLinkedin = (connection.linkedin_url || '').trim();
  if (rawLinkedin) {
    if (isHttpUrl(rawLinkedin)) {
      return rawLinkedin;
    }
    const trimmed = rawLinkedin.replace(/^\/+|\/+$/g, '');
    // Handle formats like "in/vanity" or just "vanity"
    if (trimmed.toLowerCase().startsWith('in/')) {
      const slug = trimmed.split('/')[1] || '';
      if (slug) return `https://www.linkedin.com/in/${slug}`;
    }
    if (isVanitySlug(trimmed)) {
      return `https://www.linkedin.com/in/${trimmed}`;
    }
    // If it's not a clean vanity slug, fall through to ID decode
  }

  // 2) Try decoding id (base64-encoded LinkedIn URL)
  if (connection.id) {
    const decoded = decodeBase64UrlSafe(connection.id);
    if (decoded) {
      const cleaned = decoded.trim();
      if (isHttpUrl(cleaned)) {
        return cleaned;
      }
      const trimmed = cleaned.replace(/^\/+|\/+$/g, '');
      if (trimmed.toLowerCase().startsWith('in/')) {
        // trimmed already includes "in/" prefix (e.g., "in/somevanity")
        return `https://www.linkedin.com/${trimmed}`;
      }
      if (isVanitySlug(trimmed)) {
        return `https://www.linkedin.com/in/${trimmed}`;
      }
    }
  }

  // 3) Last resort: people search with name + company
  const query = [connection.first_name, connection.last_name, connection.company]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (query) {
    return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`;
  }
  return null;
}
