import { logger } from '#utils/logger.js';
import fs from 'fs/promises';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers-sumo');

async function readPrivateKeyB64() {
  const path = process.env.CRED_SEALBOX_PRIVATE_KEY_PATH;
  if (!path) return null;
  try {
    const content = await fs.readFile(path, 'utf8');
    const b64 = content.trim();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== 32) return null; // X25519 sk length
    return b64;
  } catch {
    return null;
  }
}

export async function decryptSealboxB64Tag(ciphertextTag) {
  try {
    logger.info('Attempting sealbox decryption');

    if (typeof ciphertextTag !== 'string') {
      logger.error('Ciphertext tag is not a string');
      return null;
    }

    const prefix = 'sealbox_x25519:b64:';
    if (!ciphertextTag.startsWith(prefix)) {
      logger.error('Ciphertext tag missing required prefix');
      return null;
    }

    const b64 = ciphertextTag.substring(prefix.length);
    const sealed = Buffer.from(b64, 'base64');

    const privB64 = await readPrivateKeyB64();
    if (!privB64) {
      logger.error('Private key not configured for sealbox decryption');
      return null;
    }

    await sodium.ready;
    const sk = sodium.from_base64(privB64, sodium.base64_variants.ORIGINAL);

    // Derive public key from private key (libsodium doesn't ship direct fn, use scalar mult base point)
    const pk = sodium.crypto_scalarmult_base(sk);

    const plaintext = sodium.crypto_box_seal_open(
      new Uint8Array(sealed),
      new Uint8Array(pk),
      new Uint8Array(sk)
    );

    const result = Buffer.from(plaintext).toString('utf8');
    logger.info('Decryption successful');
    return result;
  } catch (err) {
    logger.error('Failed to decrypt sealed-box ciphertext', {
      error: err.message,
      stack: err.stack,
    });
    return null;
  }
}

/**
 * Encrypt plaintext using libsodium sealed box.
 * Returns the prefixed format: 'sealbox_x25519:b64:' + base64(ciphertext)
 *
 * @param {string} plaintext - The string to encrypt
 * @returns {Promise<string|null>} Encrypted string with prefix, or null on failure
 */
export async function encryptToSealboxB64Tag(plaintext) {
  try {
    if (typeof plaintext !== 'string') {
      logger.error('Plaintext must be a string');
      return null;
    }

    const privB64 = await readPrivateKeyB64();
    if (!privB64) {
      logger.error('Private key not configured for sealbox encryption');
      return null;
    }

    await sodium.ready;
    const sk = sodium.from_base64(privB64, sodium.base64_variants.ORIGINAL);

    // Derive public key from private key
    const pk = sodium.crypto_scalarmult_base(sk);

    // Encrypt using sealed box (uses random nonce internally)
    const messageBytes = new TextEncoder().encode(plaintext);
    const sealed = sodium.crypto_box_seal(messageBytes, pk);

    // Return prefixed format
    const b64 = Buffer.from(sealed).toString('base64');
    return `sealbox_x25519:b64:${b64}`;
  } catch (err) {
    logger.error('Failed to encrypt with sealed-box', {
      error: err.message,
      stack: err.stack,
    });
    return null;
  }
}

/**
 * Encrypt credential fields (searchPassword and jwtToken) for secure storage.
 *
 * @param {Object} credentials - Object with searchPassword and/or jwtToken fields
 * @returns {Promise<Object|null>} Object with encrypted fields, or null on failure
 */
export async function encryptCredentials(credentials) {
  try {
    if (!credentials || typeof credentials !== 'object') {
      logger.error('Credentials must be an object');
      return null;
    }

    const result = {};

    if (credentials.searchPassword) {
      const encrypted = await encryptToSealboxB64Tag(credentials.searchPassword);
      if (!encrypted) {
        logger.error('Failed to encrypt searchPassword');
        return null;
      }
      result.searchPassword = encrypted;
    }

    if (credentials.jwtToken) {
      const encrypted = await encryptToSealboxB64Tag(credentials.jwtToken);
      if (!encrypted) {
        logger.error('Failed to encrypt jwtToken');
        return null;
      }
      result.jwtToken = encrypted;
    }

    return result;
  } catch (err) {
    logger.error('Failed to encrypt credentials', { error: err.message });
    return null;
  }
}

/**
 * Extract LinkedIn credentials from request body.
 * Supports either ciphertext (preferred) or plaintext object fallback.
 * Returns { searchName, searchPassword } or null if unavailable.
 */
export async function extractLinkedInCredentials(body = {}) {
  try {
    logger.info('Attempting to extract LinkedIn credentials');

    // Preferred: ciphertext
    if (body.linkedinCredentialsCiphertext) {
      const decrypted = await decryptSealboxB64Tag(body.linkedinCredentialsCiphertext);

      if (decrypted) {
        const obj = JSON.parse(decrypted);

        if (obj?.email && obj?.password) {
          logger.info('Credentials extracted successfully from encrypted payload');
          return { searchName: obj.email, searchPassword: obj.password };
        } else {
          logger.warn('Decrypted object missing required fields');
        }
      } else {
        logger.error('Decryption failed');
      }
    } else {
      logger.error(
        'No encrypted credentials provided - plaintext fallbacks have been removed for security'
      );
    }
    return null;
  } catch (err) {
    logger.error('Failed to extract LinkedIn credentials', { error: err.message });
    return null;
  }
}
