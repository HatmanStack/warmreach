/**
 * Service Factory
 *
 * Provides utility functions for initializing common service combinations
 * used across controllers. Reduces duplication and ensures consistent
 * service initialization patterns.
 */

import { PuppeteerService } from '../../domains/automation/services/puppeteerService.js';
import { LinkedInService } from '../../domains/linkedin/services/linkedinService.js';
import { LinkedInContactService } from '../../domains/linkedin/services/linkedinContactService.js';
import DynamoDBService from '../../domains/storage/services/dynamoDBService.js';
import ControlPlaneService from '../../shared/services/controlPlaneService.js';

/**
 * Initialize the standard set of services used by search and profile controllers
 *
 * @returns {Promise<Object>} Object containing initialized services
 * @returns {PuppeteerService} services.puppeteerService - Browser automation service
 * @returns {LinkedInService} services.linkedInService - LinkedIn interaction service
 * @returns {LinkedInContactService} services.linkedInContactService - Contact management service
 * @returns {DynamoDBService} services.dynamoDBService - Database service
 * @returns {ControlPlaneService} services.controlPlaneService - Control plane client
 */
export async function initializeLinkedInServices() {
  const puppeteerService = new PuppeteerService();
  await puppeteerService.initialize();
  const controlPlaneService = new ControlPlaneService();

  return {
    puppeteerService,
    linkedInService: new LinkedInService(puppeteerService),
    linkedInContactService: new LinkedInContactService(puppeteerService),
    dynamoDBService: new DynamoDBService(),
    controlPlaneService,
  };
}

/**
 * Clean up and close all services
 *
 * @param {Object} services - Services object returned from initializeLinkedInServices
 * @returns {Promise<void>}
 */
export async function cleanupLinkedInServices(services) {
  if (services?.puppeteerService) {
    await services.puppeteerService.close();
  }
}
