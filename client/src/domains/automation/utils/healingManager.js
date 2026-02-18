import { logger } from '#utils/logger.js';
import { encryptCredentials } from '#utils/crypto.js';
import path from 'path';
import fsSync from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class HealingManager {
  async healAndRestart(params) {
    // Determine if this is a search healing or profile init healing
    if (this._isProfileInitHealing(params)) {
      return await this._healProfileInit(params);
    } else {
      return await this._healSearch(params);
    }
  }

  /**
   * Determine if this is a profile initialization healing request
   * @param {Object} params - Healing parameters
   * @returns {boolean} True if profile init healing
   */
  _isProfileInitHealing(params) {
    return (
      params.healPhase === 'profile-init' ||
      params.currentProcessingList !== undefined ||
      params.masterIndexFile !== undefined ||
      params.batchSize !== undefined
    );
  }

  /**
   * Handle profile initialization healing
   * @param {Object} params - Profile init healing parameters
   */
  async _healProfileInit(params) {
    logger.info('Initiating profile initialization healing', {
      requestId: params.requestId,
      recursionCount: params.recursionCount,
      healPhase: params.healPhase,
      healReason: params.healReason,
      currentProcessingList: params.currentProcessingList,
      currentBatch: params.currentBatch,
      currentIndex: params.currentIndex,
    });

    const stateFile = await this._createProfileInitStateFile(params);
    await this._launchProfileInitWorker(stateFile);
  }

  /**
   * Handle search healing (original functionality)
   * @param {Object} params - Search healing parameters
   */
  async _healSearch({
    companyName,
    companyRole,
    companyLocation,
    searchName,
    searchPassword,
    jwtToken,
    resumeIndex = 0,
    recursionCount = 0,
    lastPartialLinksFile = null,
    extractedCompanyNumber = null,
    extractedGeoNumber = null,
    healPhase = null,
    healReason = null,
  }) {
    logger.info('Initiating search healing', {
      recursionCount,
      healPhase,
      healReason,
      resumeIndex,
    });

    const stateFile = await this._createStateFile({
      companyName,
      companyRole,
      companyLocation,
      searchName,
      searchPassword,
      jwtToken,
      resumeIndex,
      recursionCount,
      lastPartialLinksFile,
      extractedCompanyNumber,
      extractedGeoNumber,
      healPhase,
      healReason,
    });

    await this._launchWorkerProcess(stateFile);
  }

  /**
   * Create state file for profile initialization healing
   * Encrypts sensitive credentials before writing to disk.
   * @param {Object} stateData - Profile init state data
   * @returns {Promise<string>} Path to created state file
   */
  async _createProfileInitStateFile(stateData) {
    const timestamp = Date.now();
    const stateFile = path.join('data', `profile-init-heal-${timestamp}.json`);

    // Encrypt sensitive credentials
    const encryptedCreds = await encryptCredentials({
      searchPassword: stateData.searchPassword,
      jwtToken: stateData.jwtToken,
    });

    if (!encryptedCreds && (stateData.searchPassword || stateData.jwtToken)) {
      logger.error('Failed to encrypt credentials for profile init healing state');
      throw new Error('Credential encryption failed');
    }

    const profileInitState = {
      // Authentication (encrypted)
      searchName: stateData.searchName,
      searchPassword: encryptedCreds?.searchPassword || null,
      jwtToken: encryptedCreds?.jwtToken || null,

      // Healing context
      recursionCount: stateData.recursionCount || 0,
      healPhase: stateData.healPhase || 'profile-init',
      healReason: stateData.healReason || 'Unknown error',

      // Processing state
      currentProcessingList: stateData.currentProcessingList || null,
      currentBatch: stateData.currentBatch || 0,
      currentIndex: stateData.currentIndex || 0,
      completedBatches: stateData.completedBatches || [],
      masterIndexFile: stateData.masterIndexFile,
      batchSize: stateData.batchSize || 100,
      totalConnections: stateData.totalConnections || { all: 0, pending: 0, sent: 0 },

      // Metadata
      requestId: stateData.requestId,
      userProfileId: stateData.userProfileId,
      sessionId: stateData.sessionId,
      timestamp: new Date().toISOString(),
    };

    fsSync.writeFileSync(stateFile, JSON.stringify(profileInitState, null, 2));

    logger.info(`Created profile init healing state file: ${stateFile}`, {
      requestId: stateData.requestId,
      recursionCount: profileInitState.recursionCount,
      healPhase: profileInitState.healPhase,
      credentialsEncrypted: !!encryptedCreds,
    });

    return stateFile;
  }

  /**
   * Launch profile initialization worker process
   * @param {string} stateFile - Path to state file
   */
  async _launchProfileInitWorker(stateFile) {
    const { spawn } = await import('child_process');
    const workerPath = path.join(__dirname, '../workers/profileInitWorker.js');
    const worker = spawn('node', [workerPath, stateFile], {
      detached: true,
      stdio: 'ignore',
    });
    worker.unref();

    logger.info(`Launched profile init healing worker with state file: ${stateFile}`);
  }

  /**
   * Create state file for search healing.
   * Encrypts sensitive credentials before writing to disk.
   * @param {Object} stateData - Search healing state data
   * @returns {Promise<string>} Path to created state file
   */
  async _createStateFile(stateData) {
    const stateFile = path.join('data', `search-heal-${Date.now()}.json`);

    // Encrypt sensitive credentials
    const encryptedCreds = await encryptCredentials({
      searchPassword: stateData.searchPassword,
      jwtToken: stateData.jwtToken,
    });

    if (!encryptedCreds && (stateData.searchPassword || stateData.jwtToken)) {
      logger.error('Failed to encrypt credentials for search healing state');
      throw new Error('Credential encryption failed');
    }

    const stateToWrite = {
      ...stateData,
      searchPassword: encryptedCreds?.searchPassword || null,
      jwtToken: encryptedCreds?.jwtToken || null,
    };

    fsSync.writeFileSync(stateFile, JSON.stringify(stateToWrite, null, 2));

    logger.info(`Created search healing state file: ${stateFile}`, {
      credentialsEncrypted: !!encryptedCreds,
    });

    return stateFile;
  }

  async _launchWorkerProcess(stateFile) {
    const { spawn } = await import('child_process');
    const workerPath = path.join(__dirname, '../workers/searchWorker.js');
    const worker = spawn('node', [workerPath, stateFile], {
      detached: true,
      stdio: 'ignore',
    });
    worker.unref();
    logger.info(`Launched healing worker with state file: ${stateFile}`);
  }
}
