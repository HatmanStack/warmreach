import { logger } from '#utils/logger.js';

interface BurstThrottleOptions {
  randomFn?: () => number;
  minBurstSize?: number;
  maxBurstSize?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  minBreakMs?: number;
  maxBreakMs?: number;
}

interface WaitResult {
  delayed: boolean;
  delayMs: number;
  isBreak: boolean;
  burstProgress: number;
}

interface BurstStatus {
  currentBurstCount: number;
  currentBurstSize: number;
  isInBreak: boolean;
}

export class BurstThrottleManager {
  private _random: () => number;
  minBurstSize: number;
  maxBurstSize: number;
  minDelayMs: number;
  maxDelayMs: number;
  minBreakMs: number;
  maxBreakMs: number;
  currentBurstCount: number;
  currentBurstSize: number;
  isInBreak: boolean;

  constructor(options: BurstThrottleOptions = {}) {
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

  async waitForNext(): Promise<WaitResult> {
    let delayMs: number;
    let isBreak = false;

    if (this.currentBurstCount >= this.currentBurstSize) {
      isBreak = true;
      this.isInBreak = true;
      delayMs = this._randomInt(this.minBreakMs, this.maxBreakMs);

      logger.info('Burst complete, taking break', {
        burstSize: this.currentBurstSize,
        breakMs: delayMs,
      });

      await this._sleep(delayMs);

      this.currentBurstCount = 0;
      this.currentBurstSize = this._randomInt(this.minBurstSize, this.maxBurstSize);
      this.isInBreak = false;
    } else {
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

  reset(): void {
    this.currentBurstCount = 0;
    this.currentBurstSize = this._randomInt(this.minBurstSize, this.maxBurstSize);
    this.isInBreak = false;
  }

  getStatus(): BurstStatus {
    return {
      currentBurstCount: this.currentBurstCount,
      currentBurstSize: this.currentBurstSize,
      isInBreak: this.isInBreak,
    };
  }

  private _randomInt(min: number, max: number): number {
    return Math.floor(this._random() * (max - min + 1)) + min;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
