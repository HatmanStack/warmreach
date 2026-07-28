/**
 * Profile Markdown Generator
 *
 * Converts structured profile JSON into well-formatted markdown
 * suitable for RAGStack ingestion.
 */

/** A dated role or study entry rendered into a markdown section. */
interface DatedEntry {
  title?: string;
  company?: string;
  employment_type?: string;
  start_date?: string;
  end_date?: string;
  description?: string;
}

/** An education entry. */
interface EducationEntry {
  school?: string;
  degree?: string;
  field_of_study?: string;
  start_date?: string;
  end_date?: string;
  description?: string;
}

/** A recent-activity entry. */
interface ActivityEntry {
  text?: string;
  timestamp?: string;
}

/**
 * Input to {@link generateProfileMarkdown}. Deliberately the raw shape: the
 * caller reads it straight off a DynamoDB item, so every field arrives
 * untrusted and is narrowed here rather than asserted at the boundary. Before
 * this, the sections took `Record<string, any>` and a numeric `start_date`
 * would reach `.localeCompare` and throw mid-ingestion.
 */
export type ProfileForMarkdown = Record<string, unknown>;

const MAX_ABOUT_LENGTH = 5000;

/** Narrow an untrusted value to a string, or drop it. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Narrow an untrusted value to a plain object, or drop it. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrow an untrusted value to an array of plain objects, or drop it. */
function asRecords(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is Record<string, unknown> => asRecord(entry) !== undefined);
}

/** Narrow an untrusted value to a string array, dropping non-string members. */
function asStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Project an untrusted record onto {@link DatedEntry}. */
function toDatedEntry(raw: Record<string, unknown>): DatedEntry {
  return {
    title: asString(raw.title),
    company: asString(raw.company),
    employment_type: asString(raw.employment_type),
    start_date: asString(raw.start_date),
    end_date: asString(raw.end_date),
    description: asString(raw.description),
  };
}

/** Project an untrusted record onto {@link EducationEntry}. */
function toEducationEntry(raw: Record<string, unknown>): EducationEntry {
  return {
    school: asString(raw.school),
    degree: asString(raw.degree),
    field_of_study: asString(raw.field_of_study),
    start_date: asString(raw.start_date),
    end_date: asString(raw.end_date),
    description: asString(raw.description),
  };
}

/** Project an untrusted record onto {@link ActivityEntry}. */
function toActivityEntry(raw: Record<string, unknown>): ActivityEntry {
  return {
    text: asString(raw.text),
    timestamp: asString(raw.timestamp),
  };
}

/**
 * Escapes special markdown characters in text
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeMarkdown(text: string): string {
  if (!text || typeof text !== 'string') return '';
  // Escape basic markdown special chars that could break formatting
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formats a date range string
 * @param {string} startDate - Start date
 * @param {string} endDate - End date (or 'Present')
 * @returns {string} Formatted date range
 */
function formatDateRange(startDate?: string, endDate?: string): string {
  const start = startDate || 'Unknown';
  const end = endDate || 'Present';
  return `${start} - ${end}`;
}

/**
 * Generates markdown for the current position section
 * @param {Object} currentPosition - Current position data
 * @returns {string} Markdown string
 */
function generateCurrentPositionSection(currentPosition?: DatedEntry): string {
  if (!currentPosition) return '';

  const lines = ['## Current Position'];

  if (currentPosition.title) {
    lines.push(`- **Title:** ${escapeMarkdown(currentPosition.title)}`);
  }
  if (currentPosition.company) {
    lines.push(`- **Company:** ${escapeMarkdown(currentPosition.company)}`);
  }
  if (currentPosition.employment_type) {
    lines.push(`- **Type:** ${escapeMarkdown(currentPosition.employment_type)}`);
  }
  if (currentPosition.start_date || currentPosition.end_date) {
    lines.push(
      `- **Duration:** ${formatDateRange(currentPosition.start_date, currentPosition.end_date)}`
    );
  }
  if (currentPosition.description) {
    lines.push('');
    lines.push(escapeMarkdown(currentPosition.description));
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Generates markdown for the experience section
 * @param {Array} experience - Array of experience entries
 * @returns {string} Markdown string
 */
function generateExperienceSection(experience?: DatedEntry[]): string {
  if (!experience || !Array.isArray(experience) || experience.length === 0) {
    return '';
  }

  const lines = ['## Experience'];

  // Sort by start_date descending (most recent first)
  const sortedExperience = [...experience].sort((a, b) => {
    const dateA = a.start_date || '0000';
    const dateB = b.start_date || '0000';
    return dateB.localeCompare(dateA);
  });

  for (const exp of sortedExperience) {
    if (exp.company) {
      lines.push(`### ${escapeMarkdown(exp.company)}`);
    }

    const titleParts = [];
    if (exp.title) titleParts.push(`**${escapeMarkdown(exp.title)}**`);
    if (exp.employment_type) titleParts.push(escapeMarkdown(exp.employment_type));
    if (exp.start_date || exp.end_date) {
      titleParts.push(`| ${formatDateRange(exp.start_date, exp.end_date)}`);
    }

    if (titleParts.length > 0) {
      lines.push(titleParts.join(' '));
    }

    if (exp.description) {
      lines.push('');
      lines.push(escapeMarkdown(exp.description));
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Generates markdown for the education section
 * @param {Array} education - Array of education entries
 * @returns {string} Markdown string
 */
function generateEducationSection(education?: EducationEntry[]): string {
  if (!education || !Array.isArray(education) || education.length === 0) {
    return '';
  }

  const lines = ['## Education'];

  for (const edu of education) {
    if (edu.school) {
      lines.push(`### ${escapeMarkdown(edu.school)}`);
    }

    const degreeParts = [];
    if (edu.degree) degreeParts.push(escapeMarkdown(edu.degree));
    if (edu.field_of_study) degreeParts.push(`in ${escapeMarkdown(edu.field_of_study)}`);
    if (edu.start_date || edu.end_date) {
      degreeParts.push(`| ${formatDateRange(edu.start_date, edu.end_date)}`);
    }

    if (degreeParts.length > 0) {
      lines.push(degreeParts.join(' '));
    }

    if (edu.description) {
      lines.push('');
      lines.push(escapeMarkdown(edu.description));
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Generates markdown for the skills section
 * @param {Array} skills - Array of skill strings
 * @returns {string} Markdown string
 */
function generateSkillsSection(skills?: string[]): string {
  if (!skills || !Array.isArray(skills) || skills.length === 0) {
    return '';
  }

  const escapedSkills = skills.map((skill) => escapeMarkdown(skill));
  return `## Skills\n${escapedSkills.join(', ')}`;
}

/**
 * Generates markdown for the recent activity section
 * @param {Array} recentActivity - Array of { text, timestamp } objects
 * @returns {string} Markdown string
 */
function generateActivitySection(recentActivity?: ActivityEntry[]): string {
  if (!recentActivity || !Array.isArray(recentActivity) || recentActivity.length === 0) {
    return '';
  }

  const capped = recentActivity.slice(0, 10);
  const lines = ['## Recent Activity'];

  for (const activity of capped) {
    if (activity.timestamp) {
      lines.push(`### ${escapeMarkdown(activity.timestamp)}`);
    }
    if (activity.text) {
      lines.push(escapeMarkdown(activity.text));
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Generates markdown document from profile data
 * @param {Object} profile - Profile object matching profileTextSchema
 * @returns {string} Formatted markdown string
 */
export function generateProfileMarkdown(profile: ProfileForMarkdown): string {
  if (!profile || typeof profile !== 'object') {
    throw new Error('Profile must be a non-null object');
  }

  const name = asString(profile.name);
  if (!name) {
    throw new Error('Profile must have a name');
  }

  const sections = [];

  // Header with name
  sections.push(`# ${escapeMarkdown(name)}`);

  // Metadata block
  const metadata = [];
  const headline = asString(profile.headline);
  const location = asString(profile.location);
  const profileId = asString(profile.profile_id);
  if (headline) {
    metadata.push(`**Headline:** ${escapeMarkdown(headline)}`);
  }
  if (location) {
    metadata.push(`**Location:** ${escapeMarkdown(location)}`);
  }
  if (profileId) {
    metadata.push(`**Profile ID:** ${profileId}`);
  }

  if (metadata.length > 0) {
    sections.push(metadata.join('\n'));
  }

  // About section
  let about = asString(profile.about);
  if (about) {
    if (about.length > MAX_ABOUT_LENGTH) {
      about = about.substring(0, MAX_ABOUT_LENGTH) + '...';
    }
    sections.push(`## About\n${escapeMarkdown(about)}`);
  }

  // Current position
  const currentPosition = asRecord(profile.current_position);
  const currentPositionSection = generateCurrentPositionSection(
    currentPosition && toDatedEntry(currentPosition)
  );
  if (currentPositionSection) {
    sections.push(currentPositionSection);
  }

  // Experience
  const experienceSection = generateExperienceSection(
    asRecords(profile.experience)?.map(toDatedEntry)
  );
  if (experienceSection) {
    sections.push(experienceSection);
  }

  // Education
  const educationSection = generateEducationSection(
    asRecords(profile.education)?.map(toEducationEntry)
  );
  if (educationSection) {
    sections.push(educationSection);
  }

  // Skills
  const skillsSection = generateSkillsSection(asStrings(profile.skills));
  if (skillsSection) {
    sections.push(skillsSection);
  }

  // Recent Activity
  const activitySection = generateActivitySection(
    asRecords(profile.recent_activity)?.map(toActivityEntry)
  );
  if (activitySection) {
    sections.push(activitySection);
  }

  return sections.join('\n\n');
}
