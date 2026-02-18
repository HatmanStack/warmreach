// AWS SDK configuration
export const awsConfig = {
  REGION: process.env.AWS_REGION || 'us-east-1',
  ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,

  // DynamoDB Tables
  CONNECTIONS_TABLE: process.env.CONNECTIONS_TABLE || 'linkedin-connections',
  PROFILES_TABLE: process.env.PROFILES_TABLE || 'linkedin-profiles',
  MESSAGES_TABLE: process.env.MESSAGES_TABLE || 'linkedin-messages',

  // S3 Buckets
  PROFILE_TEXT_BUCKET: process.env.PROFILE_TEXT_BUCKET || 'linkedin-profile-text',
};
