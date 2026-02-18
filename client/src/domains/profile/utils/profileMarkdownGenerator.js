/**
 * Profile Markdown Generator
 *
 * Converts structured profile JSON into well-formatted markdown
 * suitable for RAGStack ingestion.
 */

const MAX_ABOUT_LENGTH = 5000;

/**
 * Escapes special markdown characters in text
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeMarkdown(text) {
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
function formatDateRange(startDate, endDate) {
  const start = startDate || 'Unknown';
  const end = endDate || 'Present';
  return `${start} - ${end}`;
}

/**
 * Generates markdown for the current position section
 * @param {Object} currentPosition - Current position data
 * @returns {string} Markdown string
 */
function generateCurrentPositionSection(currentPosition) {
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
function generateExperienceSection(experience) {
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
function generateEducationSection(education) {
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
function generateSkillsSection(skills) {
  if (!skills || !Array.isArray(skills) || skills.length === 0) {
    return '';
  }

  const escapedSkills = skills.map((skill) => escapeMarkdown(skill));
  return `## Skills\n${escapedSkills.join(', ')}`;
}

/**
 * Generates markdown document from profile data
 * @param {Object} profile - Profile object matching profileTextSchema
 * @returns {string} Formatted markdown string
 */
export function generateProfileMarkdown(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('Profile must be a non-null object');
  }

  if (!profile.name) {
    throw new Error('Profile must have a name');
  }

  const sections = [];

  // Header with name
  sections.push(`# ${escapeMarkdown(profile.name)}`);

  // Metadata block
  const metadata = [];
  if (profile.headline) {
    metadata.push(`**Headline:** ${escapeMarkdown(profile.headline)}`);
  }
  if (profile.location) {
    metadata.push(`**Location:** ${escapeMarkdown(profile.location)}`);
  }
  if (profile.profile_id) {
    metadata.push(`**Profile ID:** ${profile.profile_id}`);
  }

  if (metadata.length > 0) {
    sections.push(metadata.join('\n'));
  }

  // About section
  if (profile.about) {
    let about = profile.about;
    if (about.length > MAX_ABOUT_LENGTH) {
      about = about.substring(0, MAX_ABOUT_LENGTH) + '...';
    }
    sections.push(`## About\n${escapeMarkdown(about)}`);
  }

  // Current position
  const currentPositionSection = generateCurrentPositionSection(profile.current_position);
  if (currentPositionSection) {
    sections.push(currentPositionSection);
  }

  // Experience
  const experienceSection = generateExperienceSection(profile.experience);
  if (experienceSection) {
    sections.push(experienceSection);
  }

  // Education
  const educationSection = generateEducationSection(profile.education);
  if (educationSection) {
    sections.push(educationSection);
  }

  // Skills
  const skillsSection = generateSkillsSection(profile.skills);
  if (skillsSection) {
    sections.push(skillsSection);
  }

  return sections.join('\n\n');
}

export default { generateProfileMarkdown };
