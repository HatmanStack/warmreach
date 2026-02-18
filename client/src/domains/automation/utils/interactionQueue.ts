import { logger } from '#utils/logger.js';

/**
 * Job status types
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/**
 * Metadata for a job
 */
export interface JobMeta {
  type?: string;
  requestId?: string;
  userId?: string;
  [key: string]: unknown;
}

/**
 * Internal job record
 */
interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  meta: JobMeta;
  result: unknown;
  error: { message: string } | null;
}

/**
 * Job status response (public API)
 */
export interface JobStatusResponse {
  jobId: string;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  meta: JobMeta;
}

/**
 * Job result response (public API)
 */
export interface JobResultResponse {
  status: JobStatus;
  result: unknown;
  error: { message: string } | null;
}

/**
 * Queue item
 */
interface QueueItem {
  jobId: string;
  run: () => Promise<void>;
}

/**
 * Constructor options
 */
export interface InteractionQueueOptions {
  concurrency?: number;
  maxJobHistory?: number;
  memoryThresholdPercent?: number;
  /** TTL for completed jobs in milliseconds (default: 30 minutes) */
  jobTtlMs?: number;
}

/**
 * Queue status for health checks
 */
export interface QueueStatus {
  activeJobs: number;
  queuedJobs: number;
  totalJobsTracked: number;
  concurrency: number;
  memoryPressure: MemoryPressureStatus;
}

/**
 * Memory pressure status
 */
export interface MemoryPressureStatus {
  heapUsedMB: number;
  heapTotalMB: number;
  heapUsedPercent: number;
  isUnderPressure: boolean;
  threshold: number;
}

/**
 * Task function type
 */
export type TaskFunction<T = unknown> = () => Promise<T>;

/**
 * Simple in-memory FIFO queue with configurable concurrency.
 * Used to serialize LinkedIn interaction jobs so concurrent requests
 * do not step on the same long-lived Puppeteer page/session.
 */
class InteractionQueue {
  private readonly concurrency: number;
  private readonly maxJobHistory: number;
  private readonly memoryThresholdPercent: number;
  private readonly jobTtlMs: number;
  private queue: QueueItem[];
  private activeCount: number;
  private jobs: Map<string, JobRecord>;
  private lastTtlCleanup: number;

  constructor(options: InteractionQueueOptions = {}) {
    // Force serialization for current single-Page architecture
    const defaultConcurrency = 1;
    this.concurrency = Math.max(1, Number(options.concurrency) || defaultConcurrency);
    this.maxJobHistory = options.maxJobHistory || 1000;
    this.memoryThresholdPercent = options.memoryThresholdPercent || 80;
    this.jobTtlMs = options.jobTtlMs || 30 * 60 * 1000; // 30 minutes default
    this.queue = [];
    this.activeCount = 0;
    this.jobs = new Map();
    this.lastTtlCleanup = Date.now();
  }

  /**
   * Check if system is under memory pressure.
   * @returns Memory pressure status
   */
  checkMemoryPressure(): MemoryPressureStatus {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const heapUsedPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);
    const isUnderPressure = heapUsedPercent >= this.memoryThresholdPercent;

    if (isUnderPressure) {
      logger.warn('InteractionQueue: Memory pressure detected', {
        heapUsedMB,
        heapTotalMB,
        heapUsedPercent,
        threshold: this.memoryThresholdPercent,
      });
      // Aggressive eviction when under pressure
      this._aggressiveEviction();
    }

    return {
      heapUsedMB,
      heapTotalMB,
      heapUsedPercent,
      isUnderPressure,
      threshold: this.memoryThresholdPercent,
    };
  }

  /**
   * Get queue status for health checks.
   * @returns Queue status
   */
  getQueueStatus(): QueueStatus {
    return {
      activeJobs: this.activeCount,
      queuedJobs: this.queue.length,
      totalJobsTracked: this.jobs.size,
      concurrency: this.concurrency,
      memoryPressure: this.checkMemoryPressure(),
    };
  }

  /**
   * Aggressive eviction when under memory pressure.
   * Removes more completed jobs than normal eviction.
   */
  private _aggressiveEviction(): void {
    const targetSize = Math.floor(this.maxJobHistory * 0.5); // Reduce to 50% of max
    if (this.jobs.size <= targetSize) return;

    const completed: [string, number][] = [];
    for (const [id, job] of this.jobs) {
      if (job.status === 'succeeded' || job.status === 'failed') {
        completed.push([id, job.finishedAt || 0]);
      }
    }
    completed.sort((a, b) => a[1] - b[1]);

    const toRemove = completed.slice(0, this.jobs.size - targetSize);
    for (const [id] of toRemove) {
      this.jobs.delete(id);
    }

    if (toRemove.length > 0) {
      logger.info('InteractionQueue: Aggressive eviction completed', {
        evicted: toRemove.length,
        remaining: this.jobs.size,
      });
    }
  }

  /**
   * Enqueue a unit of work.
   * @param taskFn - async function performing the job, returns a result
   * @param meta - metadata for logging/inspection (e.g., { type, requestId, userId })
   * @returns resolves/rejects with task result
   */
  enqueue<T>(taskFn: TaskFunction<T>, meta: JobMeta = {}): Promise<T> {
    if (typeof taskFn !== 'function') {
      throw new Error('enqueue requires a function');
    }

    const jobId = this._generateJobId(meta);
    const jobRecord: JobRecord = {
      id: jobId,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      meta,
      result: undefined,
      error: null,
    };

    this.jobs.set(jobId, jobRecord);

    return new Promise<T>((resolve, reject) => {
      const run = async (): Promise<void> => {
        jobRecord.status = 'running';
        jobRecord.startedAt = Date.now();
        logger.info('InteractionQueue: job started', {
          jobId,
          meta,
          activeCount: this.activeCount,
        });
        try {
          const result = await taskFn();
          jobRecord.status = 'succeeded';
          jobRecord.finishedAt = Date.now();
          jobRecord.result = result;
          logger.info('InteractionQueue: job completed', {
            jobId,
            durationMs: jobRecord.finishedAt - jobRecord.startedAt,
          });
          resolve(result);
        } catch (err) {
          jobRecord.status = 'failed';
          jobRecord.finishedAt = Date.now();
          const error = err as Error;
          jobRecord.error = { message: error?.message || String(err) };
          logger.error('InteractionQueue: job failed', {
            jobId,
            error: error?.message,
            stack: error?.stack,
          });
          reject(err);
        } finally {
          this.activeCount = Math.max(0, this.activeCount - 1);
          this._evictOldJobs();
          this._dequeueNext();
        }
      };

      this.queue.push({ jobId, run });
      logger.debug('InteractionQueue: job enqueued', { jobId, queueLength: this.queue.length });
      this._dequeueNext();
    });
  }

  /**
   * Get the status of a job by ID.
   */
  getStatus(jobId: string): JobStatusResponse | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const { status, createdAt, startedAt, finishedAt, meta } = job;
    return { jobId, status, createdAt, startedAt, finishedAt, meta };
  }

  /**
   * Get the result of a job by ID.
   */
  getResult(jobId: string): JobResultResponse | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return { status: job.status, result: job.result, error: job.error };
  }

  /**
   * Dequeue and run the next job if capacity allows.
   */
  private _dequeueNext(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.activeCount += 1;
      try {
        next.run();
      } catch (err) {
        const error = err as Error;
        logger.error('InteractionQueue: unexpected error starting job', {
          jobId: next.jobId,
          error: error?.message,
        });
        this.activeCount = Math.max(0, this.activeCount - 1);
      }
    }
  }

  /**
   * Evict oldest completed/failed jobs when over maxJobHistory.
   */
  private _evictOldJobs(): void {
    // Also run TTL cleanup periodically (every 5 minutes)
    const now = Date.now();
    if (now - this.lastTtlCleanup > 5 * 60 * 1000) {
      this._evictStaleJobs();
      this.lastTtlCleanup = now;
    }

    if (this.jobs.size <= this.maxJobHistory) return;
    const completed: [string, number][] = [];
    for (const [id, job] of this.jobs) {
      if (job.status === 'succeeded' || job.status === 'failed') {
        completed.push([id, job.finishedAt || 0]);
      }
    }
    completed.sort((a, b) => a[1] - b[1]);
    const toRemove = completed.slice(0, this.jobs.size - this.maxJobHistory);
    for (const [id] of toRemove) {
      this.jobs.delete(id);
    }
  }

  /**
   * Evict completed/failed jobs older than TTL threshold.
   * Prevents stale job accumulation even when under maxJobHistory limit.
   */
  private _evictStaleJobs(): void {
    const staleThreshold = Date.now() - this.jobTtlMs;
    let evictedCount = 0;

    for (const [id, job] of this.jobs) {
      if (job.status === 'succeeded' || job.status === 'failed') {
        const jobTime = job.finishedAt || job.createdAt;
        if (jobTime < staleThreshold) {
          this.jobs.delete(id);
          evictedCount++;
        }
      }
    }

    if (evictedCount > 0) {
      logger.debug('InteractionQueue: TTL eviction completed', {
        evicted: evictedCount,
        remaining: this.jobs.size,
        ttlMs: this.jobTtlMs,
      });
    }
  }

  /**
   * Generate a unique job ID.
   */
  private _generateJobId(meta: JobMeta): string {
    const now = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const type = meta?.type || 'job';
    return `${type}-${now}-${rand}`;
  }
}

// Export a singleton queue instance for linkedin interactions
export const linkedInInteractionQueue = new InteractionQueue();

export default InteractionQueue;
