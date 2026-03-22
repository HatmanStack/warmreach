import type { ActivityEvent } from '@/shared/types';

export function formatActivityDescription(event: ActivityEvent): string {
  switch (event.eventType) {
    case 'connection_status_change':
      return event.metadata?.status
        ? `Connection status changed to ${event.metadata.status}`
        : `Connection updated: ${event.metadata?.profileId || 'unknown'}`;
    case 'message_sent':
      return 'Message sent';
    case 'command_dispatched':
      return `Command dispatched: ${(event.metadata?.commandType as string) || 'unknown'}`;
    case 'ai_message_generated':
      return 'AI message generated';
    case 'ai_tone_analysis':
      return 'Tone analysis completed';
    case 'ai_deep_research':
      return 'Deep research completed';
    case 'note_added':
      return 'Note added';
    case 'user_settings_updated':
      return 'Settings updated';
    case 'profile_metadata_updated':
      return 'Profile updated';
    case 'profile_ingested':
      return 'Profile ingested for search';
    default:
      return event.eventType;
  }
}

export function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}
