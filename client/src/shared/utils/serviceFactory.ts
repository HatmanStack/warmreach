/**
 * Service Factory
 *
 * Provides utility functions for initializing common service combinations
 * used across controllers. Reduces duplication and ensures consistent
 * service initialization patterns.
 */

import { PuppeteerService } from '../../domains/automation/services/puppeteerService.js';
import { LinkedInService } from '../../domains/linkedin/services/linkedinService.js';
import DynamoDBService from '../../domains/storage/services/dynamoDBService.js';
import ControlPlaneService from '../../shared/services/controlPlaneService.js';

export interface LinkedInServices {
  puppeteerService: PuppeteerService;
  linkedInService: LinkedInService;
  linkedInContactService: null;
  dynamoDBService: DynamoDBService;
  controlPlaneService: ControlPlaneService;
}

export async function initializeLinkedInServices(): Promise<LinkedInServices> {
  const puppeteerService = new PuppeteerService();
  await puppeteerService.initialize();
  const controlPlaneService = new ControlPlaneService();

  return {
    puppeteerService,
    linkedInService: new LinkedInService(puppeteerService),
    linkedInContactService: null, // Stub: replaced by local scraper (Phase 2)
    dynamoDBService: new DynamoDBService(),
    controlPlaneService,
  };
}

export async function cleanupLinkedInServices(
  services: Partial<LinkedInServices> | null
): Promise<void> {
  if (services?.puppeteerService) {
    await services.puppeteerService.close();
  }
}
