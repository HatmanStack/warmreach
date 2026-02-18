import fs from 'fs/promises';
import path from 'path';
import { logger } from '#utils/logger.js';

export class FileHelpers {
  static async ensureDirectoryExists(dirPath) {
    try {
      await fs.access(dirPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.mkdir(dirPath, { recursive: true });
        logger.info(`Created directory: ${dirPath}`);
      } else {
        throw error;
      }
    }
  }

  static async writeJSON(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      await this.ensureDirectoryExists(dir);

      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      logger.debug(`Written JSON to: ${filePath}`);
    } catch (error) {
      logger.error(`Error writing JSON file ${filePath}:`, error);
      throw error;
    }
  }

  static async readJSON(filePath) {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn(`File not found: ${filePath}`);
        return null;
      }
      logger.error(`Error reading JSON file ${filePath}:`, error);
      throw error;
    }
  }

  static async appendToFile(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      await this.ensureDirectoryExists(dir);

      await fs.appendFile(filePath, data);
      logger.debug(`Appended to file: ${filePath}`);
    } catch (error) {
      logger.error(`Error appending to file ${filePath}:`, error);
      throw error;
    }
  }

  static fileToGenerativePart(filePath, mimeType) {
    try {
      const data = fs.readFileSync(filePath);
      return {
        inlineData: {
          data: Buffer.from(data).toString('base64'),
          mimeType,
        },
      };
    } catch (error) {
      logger.error(`Error reading file for generative AI: ${filePath}`, error);
      throw error;
    }
  }
}

export default FileHelpers;
