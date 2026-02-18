import { logger } from '#utils/logger.js';
import { validateLinkedInCredentials } from '../../../shared/utils/credentialValidator.js';

export class SearchRequestValidator {
  static validateRequest(body, jwtToken) {
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
