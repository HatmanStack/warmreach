import { logger } from '#utils/logger.js';

/**
 * Burst-pattern throttle manager for human-like pacing.
 *
 * Processes profiles in bursts (10-15 per burst by default) with
 * random delays within bursts (3-8s) and longer breaks between
 * bursts (5-15 min).
 */
export class BurstThrottleManager {
  constructor(options = {}) {
    this._random = options.randomFn || Math.random;
    this.minBurstSize = options.minBurstSize ?? 10;
    this.maxBurstSize = options.maxBurstSize ?? 15;
    this.minDelayMs = options.minDelayMs ?? 3000;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
    this.minBreakMs = options.minBreakMs ?? 300000;
    this.maxBreakMs = options.maxBreakMs ?? 900000;

    this.currentBurstCount = 0;
    this.currentBurstSize = this._randomInt(this.minBurstSize, this.maxBurstSize);
    this.isInBreak = false;
  }

  /**
   * Wait before processing the next item.
   * If the current burst is complete, take a longer break.
   *
   * @returns {Promise<Object>} Delay info
   */
  async waitForNext() {
    let delayMs;
    let isBreak = false;

    if (this.currentBurstCount >= this.currentBurstSize) {
      // Burst complete -- take a break
      isBreak = true;
      this.isInBreak = true;
      delayMs = this._randomInt(this.minBreakMs, this.maxBreakMs);

      logger.info('Burst complete, taking break', {
        burstSize: this.currentBurstSize,
        breakMs: delayMs,
      });

      await this._sleep(delayMs);

      // Reset burst
      this.currentBurstCount = 0;
      this.currentBurstSize = this._randomInt(this.minBurstSize, this.maxBurstSize);
      this.isInBreak = false;
    } else {
      // Within burst -- short random delay
      delayMs = this._randomInt(this.minDelayMs, this.maxDelayMs);
      await this._sleep(delayMs);
    }

    this.currentBurstCount++;

    return {
      delayed: true,
      delayMs,
      isBreak,
      burstProgress: this.currentBurstCount / this.currentBurstSize,
    };
  }

  /**
   * Reset all state to initial values.
   */
  reset() {
    this.currentBurstCount = 0;
    this.currentBurstSize = this._randomInt(this.minBurstSize, this.maxBurstSize);
    this.isInBreak = false;
  }

  /**
   * Get current status.
   */
  getStatus() {
    return {
      currentBurstCount: this.currentBurstCount,
      currentBurstSize: this.currentBurstSize,
      isInBreak: this.isInBreak,
    };
  }

  _randomInt(min, max) {
    return Math.floor(this._random() * (max - min + 1)) + min;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
