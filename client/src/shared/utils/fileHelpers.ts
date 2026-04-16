import fs from 'fs/promises';
import path from 'path';
import { logger } from '#utils/logger.js';

interface NodeError extends Error {
  code?: string;
}

interface GenerativePart {
  inlineData: {
    data: string;
    mimeType: string;
  };
}

export class FileHelpers {
  static async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch (err: unknown) {
      const error = err as NodeError;
      if (error.code === 'ENOENT') {
        await fs.mkdir(dirPath, { recursive: true });
        logger.info(`Created directory: ${dirPath}`);
      } else {
        throw error;
      }
    }
  }

  static async writeJSON(filePath: string, data: unknown): Promise<void> {
    try {
      const dir = path.dirname(filePath);
      await this.ensureDirectoryExists(dir);

      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      logger.debug(`Written JSON to: ${filePath}`);
    } catch (error: unknown) {
      logger.error(`Error writing JSON file ${filePath}:`, error);
      throw error;
    }
  }

  static async readJSON(filePath: string): Promise<unknown> {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data) as unknown;
    } catch (err: unknown) {
      const error = err as NodeError;
      if (error.code === 'ENOENT') {
        logger.warn(`File not found: ${filePath}`);
        return null;
      }
      logger.error(`Error reading JSON file ${filePath}:`, error);
      throw error;
    }
  }

  static async appendToFile(filePath: string, data: string): Promise<void> {
    try {
      const dir = path.dirname(filePath);
      await this.ensureDirectoryExists(dir);

      await fs.appendFile(filePath, data);
      logger.debug(`Appended to file: ${filePath}`);
    } catch (error: unknown) {
      logger.error(`Error appending to file ${filePath}:`, error);
      throw error;
    }
  }

  static async fileToGenerativePart(filePath: string, mimeType: string): Promise<GenerativePart> {
    try {
      const data = await fs.readFile(filePath);
      return {
        inlineData: {
          data: Buffer.from(data).toString('base64'),
          mimeType,
        },
      };
    } catch (error: unknown) {
      logger.error(`Error reading file for generative AI: ${filePath}`, error);
      throw error;
    }
  }
}
