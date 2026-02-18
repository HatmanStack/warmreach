/**
 * Search Healing Worker
 *
 * This worker script is spawned by HealingManager to resume a search operation
 * after a browser crash or other failure. It reads the healing state from a
 * JSON file, decrypts the credentials, and resumes the search operation.
 *
 * Usage: node searchWorker.js <state-file-path>
 */

import fs from 'fs/promises';
import { decryptSealboxB64Tag } from '#utils/crypto.js';
import { logger } from '#utils/logger.js';

async function cleanupStateFile(stateFile) {
  try {
    await fs.unlink(stateFile);
    logger.info('State file cleaned up', { stateFile });
  } catch (err) {
    logger.warn('Failed to clean up state file', { error: err.message });
  }
}

async function main() {
  const stateFile = process.argv[2];

  if (!stateFile) {
    logger.error('No state file provided');
    process.exit(1);
  }

  logger.info('Search healing worker started', { stateFile });

  try {
    // Read and parse state file
    const stateJson = await fs.readFile(stateFile, 'utf8');
    const state = JSON.parse(stateJson);

    logger.info('Loaded healing state', {
      companyName: state.companyName,
      resumeIndex: state.resumeIndex,
      recursionCount: state.recursionCount,
      healPhase: state.healPhase,
    });

    // Decrypt credentials
    if (state.searchPassword) {
      const decrypted = await decryptSealboxB64Tag(state.searchPassword);
      if (!decrypted) {
        logger.error('Failed to decrypt searchPassword');
        await cleanupStateFile(stateFile);
        process.exit(1);
      }
      state.searchPassword = decrypted;
    }

    if (state.jwtToken) {
      const decrypted = await decryptSealboxB64Tag(state.jwtToken);
      if (!decrypted) {
        logger.error('Failed to decrypt jwtToken');
        await cleanupStateFile(stateFile);
        process.exit(1);
      }
      state.jwtToken = decrypted;
    }

    logger.info('Credentials decrypted successfully');

    // NOTE: State file cleanup deferred until after successful resume
    // This preserves recovery capability if resume fails

    // TODO: Implement actual search resumption logic
    // This would involve:
    // 1. Initialize browser with the decrypted credentials
    // 2. Navigate to LinkedIn
    // 3. Resume search from state.resumeIndex
    // 4. Continue processing results

    // For now, log error and exit non-zero since resumption not implemented
    logger.error('Search healing worker: resumption logic not implemented', {
      resumeIndex: state.resumeIndex,
      companyName: state.companyName,
    });

    // Cleanup state file since we can't actually resume
    await cleanupStateFile(stateFile);
    process.exit(1);
  } catch (err) {
    logger.error('Search healing worker failed', {
      error: err.message,
      stack: err.stack,
    });
    // Cleanup state file before exit
    await cleanupStateFile(stateFile);
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error('Unhandled error in search worker', { error: err.message });
  process.exit(1);
});
