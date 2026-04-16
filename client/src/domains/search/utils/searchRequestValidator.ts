import { logger } from '#utils/logger.js';
import {
  validateLinkedInCredentials,
  type CredentialValidationResult,
} from '../../../shared/utils/credentialValidator.js';

interface SearchRequestBody {
  companyName?: string;
  companyRole?: string;
  companyLocation?: string;
  searchName?: string;
  searchPassword?: string;
  linkedinCredentialsCiphertext?: string;
  linkedinCredentials?: { email?: string; password?: string };
}

export class SearchRequestValidator {
  static validateRequest(
    body: SearchRequestBody,
    jwtToken: string | undefined
  ): CredentialValidationResult {
    const {
      companyName,
      companyRole,
      companyLocation,
      searchName,
      searchPassword,
      linkedinCredentialsCiphertext,
      linkedinCredentials,
    } = body;

    logger.info('Request body received:', {
      companyName,
      companyRole,
      companyLocation,
      searchName,
      hasPassword: !!searchPassword,
      hasJwtToken: !!jwtToken,
    });

    return validateLinkedInCredentials({
      searchName,
      searchPassword,
      linkedinCredentialsCiphertext,
      linkedinCredentials,
      jwtToken,
      actionType: 'search',
    });
  }
}
