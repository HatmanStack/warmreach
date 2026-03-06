/**
 * Auth feature type definitions
 */

import { CognitoUserAttribute } from 'amazon-cognito-identity-js';

export interface AuthError {
  code?: string;
  name?: string;
  message: string;
}

export type CognitoAttributeList = CognitoUserAttribute[];
