// LinkedIn automation configuration
export const linkedinConfig = {
  // Rate limits
  MAX_CONNECTIONS_PER_DAY: 100,
  MAX_MESSAGES_PER_HOUR: 20,
  MAX_PROFILE_VIEWS_PER_DAY: 200,

  // Delays (in milliseconds)
  MIN_ACTION_DELAY: 2000, // 2 seconds
  MAX_ACTION_DELAY: 5000, // 5 seconds
  PAGE_LOAD_TIMEOUT: 30000, // 30 seconds
};
