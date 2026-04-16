import { logger } from '#utils/logger.js';
import { encryptCredentials } from '#utils/crypto.js';
import path from 'path';
import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type HealingParams = Record<string, any>;

export class HealingManager {
  async healAndRestart(params: HealingParams): Promise<void> {
    if (this._isProfileInitHealing(params)) {
      return await this._healProfileInit(params);
    } else {
      return await this._healSearch(params);
    }
  }

  _isProfileInitHealing(params: HealingParams): boolean {
    return (
      params.healPhase === 'profile-init' ||
      params.currentProcessingList !== undefined ||
      params.masterIndexFile !== undefined ||
      params.batchSize !== undefined
    );
  }

  async _healProfileInit(params: HealingParams): Promise<void> {
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

  async _healSearch({
    companyName,
    companyRole,
    companyLocation,
    searchName,
    searchPassword,
    jwtToken,
    resumeIndex = 0,
    recursionCount = 0,
    lastPartialLinksFile = null as string | null,
    extractedCompanyNumber = null as string | null,
    extractedGeoNumber = null as string | null,
    healPhase = null as string | null,
    healReason = null as string | null,
  }: HealingParams): Promise<void> {
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

  async _createProfileInitStateFile(stateData: HealingParams): Promise<string> {
    const timestamp = Date.now();
    const stateFile = path.join('data', `profile-init-heal-${timestamp}.json`);

    const encryptedCreds = await encryptCredentials({
      searchPassword: stateData.searchPassword,
      jwtToken: stateData.jwtToken,
    });

    if (!encryptedCreds && (stateData.searchPassword || stateData.jwtToken)) {
      logger.error('Failed to encrypt credentials for profile init healing state');
      throw new Error('Credential encryption failed');
    }

    const profileInitState = {
      searchName: stateData.searchName,
      searchPassword: encryptedCreds?.searchPassword || null,
      jwtToken: encryptedCreds?.jwtToken || null,
      recursionCount: stateData.recursionCount || 0,
      healPhase: stateData.healPhase || 'profile-init',
      healReason: stateData.healReason || 'Unknown error',
      currentProcessingList: stateData.currentProcessingList || null,
      currentBatch: stateData.currentBatch || 0,
      currentIndex: stateData.currentIndex || 0,
      completedBatches: stateData.completedBatches || [],
      masterIndexFile: stateData.masterIndexFile,
      batchSize: stateData.batchSize || 100,
      totalConnections: stateData.totalConnections || { all: 0, pending: 0, sent: 0 },
      requestId: stateData.requestId,
      userProfileId: stateData.userProfileId,
      sessionId: stateData.sessionId,
      timestamp: new Date().toISOString(),
    };

    await writeFile(stateFile, JSON.stringify(profileInitState, null, 2));

    logger.info(`Created profile init healing state file: ${stateFile}`, {
      requestId: stateData.requestId,
      recursionCount: profileInitState.recursionCount,
      healPhase: profileInitState.healPhase,
      credentialsEncrypted: !!encryptedCreds,
    });

    return stateFile;
  }

  async _launchProfileInitWorker(stateFile: string): Promise<void> {
    const { spawn } = await import('child_process');
    const workerPath = path.join(__dirname, '../workers/profileInitWorker.js');
    const worker = spawn('node', [workerPath, stateFile], {
      detached: true,
      stdio: 'ignore',
    });
    worker.unref();

    logger.info(`Launched profile init healing worker with state file: ${stateFile}`);
  }

  async _createStateFile(stateData: HealingParams): Promise<string> {
    const stateFile = path.join('data', `search-heal-${Date.now()}.json`);

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

    await writeFile(stateFile, JSON.stringify(stateToWrite, null, 2));

    logger.info(`Created search healing state file: ${stateFile}`, {
      credentialsEncrypted: !!encryptedCreds,
    });

    return stateFile;
  }

  async _launchWorkerProcess(stateFile: string): Promise<void> {
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
