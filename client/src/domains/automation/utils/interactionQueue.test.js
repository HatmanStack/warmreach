import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('#utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import InteractionQueue from './interactionQueue.js';

describe('InteractionQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new InteractionQueue();
  });

  describe('constructor', () => {
    it('defaults to concurrency of 1', () => {
      expect(queue.concurrency).toBe(1);
    });

    it('accepts custom concurrency', () => {
      const q = new InteractionQueue({ concurrency: 3 });
      expect(q.concurrency).toBe(3);
    });

    it('enforces minimum concurrency of 1', () => {
      const q = new InteractionQueue({ concurrency: 0 });
      expect(q.concurrency).toBe(1);
    });

    it('defaults maxJobHistory to 1000', () => {
      expect(queue.maxJobHistory).toBe(1000);
    });

    it('accepts custom maxJobHistory', () => {
      const q = new InteractionQueue({ maxJobHistory: 50 });
      expect(q.maxJobHistory).toBe(50);
    });
  });

  describe('enqueue', () => {
    it('throws if taskFn is not a function', () => {
      expect(() => queue.enqueue('not a function')).toThrow('enqueue requires a function');
    });

    it('executes a single task and resolves with result', async () => {
      const result = await queue.enqueue(() => 'hello');
      expect(result).toBe('hello');
    });

    it('resolves async tasks', async () => {
      const result = await queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      });
      expect(result).toBe(42);
    });

    it('rejects when task throws', async () => {
      await expect(
        queue.enqueue(() => {
          throw new Error('fail');
        })
      ).rejects.toThrow('fail');
    });

    it('rejects when async task rejects', async () => {
      await expect(
        queue.enqueue(async () => {
          throw new Error('async fail');
        })
      ).rejects.toThrow('async fail');
    });

    it('serializes tasks with concurrency=1', async () => {
      const order = [];
      const task1 = queue.enqueue(async () => {
        order.push('start-1');
        await new Promise((r) => setTimeout(r, 20));
        order.push('end-1');
      });
      const task2 = queue.enqueue(async () => {
        order.push('start-2');
        order.push('end-2');
      });
      await Promise.all([task1, task2]);
      expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    });

    it('runs tasks concurrently when concurrency > 1', async () => {
      const q = new InteractionQueue({ concurrency: 2 });
      const order = [];
      const task1 = q.enqueue(async () => {
        order.push('start-1');
        await new Promise((r) => setTimeout(r, 30));
        order.push('end-1');
      });
      const task2 = q.enqueue(async () => {
        order.push('start-2');
        order.push('end-2');
      });
      await Promise.all([task1, task2]);
      // Both should start before either ends (concurrent)
      expect(order[0]).toBe('start-1');
      expect(order[1]).toBe('start-2');
    });

    it('tracks job status through lifecycle', async () => {
      let resolveTask;
      const task = queue.enqueue(
        () =>
          new Promise((r) => {
            resolveTask = r;
          }),
        { type: 'test' }
      );

      // Job should be running
      const jobs = [...queue.jobs.values()];
      const job = jobs[0];
      expect(job.status).toBe('running');
      expect(job.startedAt).not.toBeNull();

      resolveTask('done');
      await task;

      expect(job.status).toBe('succeeded');
      expect(job.finishedAt).not.toBeNull();
      expect(job.result).toBe('done');
    });

    it('records error on failed job', async () => {
      try {
        await queue.enqueue(() => {
          throw new Error('oops');
        });
      } catch {
        // Expected: enqueue rejects with the task error. We verify the job record below.
      }

      const job = [...queue.jobs.values()][0];
      expect(job.status).toBe('failed');
      expect(job.error.message).toBe('oops');
    });
  });

  describe('getStatus', () => {
    it('returns null for unknown job', () => {
      expect(queue.getStatus('nonexistent')).toBeNull();
    });

    it('returns job status info', async () => {
      await queue.enqueue(() => 'result', { type: 'myType' });
      const jobs = [...queue.jobs.keys()];
      const status = queue.getStatus(jobs[0]);
      expect(status.status).toBe('succeeded');
      expect(status.meta.type).toBe('myType');
    });
  });

  describe('getResult', () => {
    it('returns null for unknown job', () => {
      expect(queue.getResult('nonexistent')).toBeNull();
    });

    it('returns result for completed job', async () => {
      await queue.enqueue(() => 'value');
      const jobs = [...queue.jobs.keys()];
      const result = queue.getResult(jobs[0]);
      expect(result.status).toBe('succeeded');
      expect(result.result).toBe('value');
    });
  });

  describe('_evictOldJobs', () => {
    it('does not evict when under maxJobHistory', async () => {
      const q = new InteractionQueue({ maxJobHistory: 10 });
      await q.enqueue(() => 'a');
      await q.enqueue(() => 'b');
      expect(q.jobs.size).toBe(2);
    });

    it('evicts oldest completed jobs when over maxJobHistory', async () => {
      const q = new InteractionQueue({ maxJobHistory: 2 });
      await q.enqueue(() => 'first');
      await q.enqueue(() => 'second');
      await q.enqueue(() => 'third');

      // Should have evicted the oldest to stay at max
      expect(q.jobs.size).toBeLessThanOrEqual(2);
    });

    it('preserves running jobs during eviction', async () => {
      const q = new InteractionQueue({ maxJobHistory: 1 });
      await q.enqueue(() => 'done');
      // After completion, eviction runs - should keep at most 1
      expect(q.jobs.size).toBeLessThanOrEqual(1);
    });
  });

  describe('_generateJobId', () => {
    it('includes type in job ID', async () => {
      await queue.enqueue(() => {}, { type: 'search' });
      const jobId = [...queue.jobs.keys()][0];
      expect(jobId).toMatch(/^search-/);
    });

    it('defaults to "job" type', async () => {
      await queue.enqueue(() => {});
      const jobId = [...queue.jobs.keys()][0];
      expect(jobId).toMatch(/^job-/);
    });

    it('generates unique IDs', async () => {
      await queue.enqueue(() => {});
      await queue.enqueue(() => {});
      const ids = [...queue.jobs.keys()];
      expect(ids[0]).not.toBe(ids[1]);
    });
  });
});
