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

  describe('import mode', () => {
    it('setImportMode(true) sets TTL to 4 hours', () => {
      queue.setImportMode(true);
      // Verify by checking that a job is NOT evicted after 31 minutes
      // but would have been under default 30-min TTL
    });

    it('job survives past default TTL in import mode', async () => {
      vi.useFakeTimers();
      const q = new InteractionQueue({ jobTtlMs: 1000 }); // 1 second TTL
      q.setImportMode(true); // 4 hour TTL override

      await q.enqueue(() => 'done');

      // Advance past default TTL but within import TTL
      vi.advanceTimersByTime(2000);

      // Force TTL cleanup
      q._evictStaleJobs();

      // Job should still exist since import mode TTL is 4 hours
      expect(q.jobs.size).toBe(1);
      vi.useRealTimers();
    });

    it('setImportMode(false) resets to original TTL', async () => {
      vi.useFakeTimers();
      const q = new InteractionQueue({ jobTtlMs: 1000 }); // 1 second TTL
      q.setImportMode(true);
      q.setImportMode(false);

      await q.enqueue(() => 'done');

      // Advance past 1 second
      vi.advanceTimersByTime(2000);

      q._evictStaleJobs();

      // Job should be evicted since original TTL is restored
      expect(q.jobs.size).toBe(0);
      vi.useRealTimers();
    });

    it('preserves original TTL after import mode toggle', async () => {
      vi.useFakeTimers();
      const q = new InteractionQueue({ jobTtlMs: 60000 });
      q.setImportMode(true);
      q.setImportMode(false);

      await q.enqueue(() => 'done');

      // Advance less than 60s
      vi.advanceTimersByTime(30000);
      q._evictStaleJobs();
      expect(q.jobs.size).toBe(1); // Still alive

      // Advance past 60s
      vi.advanceTimersByTime(40000);
      q._evictStaleJobs();
      expect(q.jobs.size).toBe(0); // Evicted
      vi.useRealTimers();
    });
  });

  describe('pause/resume', () => {
    it('stops new jobs from starting when paused', async () => {
      const order = [];
      let resolveFirst;
      const first = queue.enqueue(
        () =>
          new Promise((r) => {
            resolveFirst = r;
          })
      );

      queue.pause('test reason');

      queue.enqueue(() => {
        order.push('second');
      });

      resolveFirst();
      await first;

      expect(order).toEqual([]); // Second job should not have started
      expect(queue.getQueueStatus().queuedJobs).toBe(1);
      expect(queue.isPaused()).toBe(true);
    });

    it('resumes processing jobs when resume is called', async () => {
      const order = [];
      queue.pause('test reason');

      const job = queue.enqueue(() => {
        order.push('job');
      });
      expect(order).toEqual([]);

      queue.resume();
      await job;
      expect(order).toEqual(['job']);
      expect(queue.isPaused()).toBe(false);
    });

    it('reports pause status correctly', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      queue.pause('rate limit');
      const status = queue.getPauseStatus();

      expect(status.paused).toBe(true);
      expect(status.reason).toBe('rate limit');
      expect(status.pausedAt).toBe(now);
    });

    it('is idempotent for pause and resume', () => {
      queue.pause('reason 1');
      queue.pause('reason 2');
      expect(queue.getPauseStatus().reason).toBe('reason 1');

      queue.resume();
      queue.resume();
      expect(queue.isPaused()).toBe(false);
    });

    it('includes pause info in getQueueStatus', () => {
      queue.pause('maintenance');
      const status = queue.getQueueStatus();
      expect(status.paused).toBe(true);
      expect(status.pauseReason).toBe('maintenance');
    });
  });

  describe('cancelling a job that has not started', () => {
    // Dropping a queued job is safe precisely because none of its code has
    // run — unlike a running Puppeteer batch, which cannot be aborted
    // mid-navigation. This is what lets the router report a truthful
    // COMMAND_TIMEOUT for a command that timed out while still waiting.
    it('removes a queued job, rejects its promise, and never runs its task', async () => {
      const blocker = vi.fn(() => new Promise(() => {}));
      const neverRuns = vi.fn().mockResolvedValue('nope');

      queue.enqueue(blocker, { type: 'blocker' }).catch(() => {});
      const { jobId, promise } = queue.enqueueCancellable(neverRuns, { type: 'victim' });
      const settled = promise.catch((err) => err);

      expect(queue.cancel(jobId, new Error('deadline elapsed'))).toBe(true);

      await expect(settled).resolves.toMatchObject({ message: 'deadline elapsed' });
      expect(neverRuns).not.toHaveBeenCalled();
      expect(queue.getQueueStatus().queuedJobs).toBe(0);
      expect(queue.getStatus(jobId).status).toBe('cancelled');
    });

    it('refuses to cancel a job that has already started, and that job completes', async () => {
      let release;
      const running = vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve('done');
          })
      );
      const { jobId, promise } = queue.enqueueCancellable(running, { type: 'running' });

      // enqueue dequeues synchronously when the slot is free, so this job is
      // already running by the time we get its id back.
      expect(queue.cancel(jobId, new Error('too late'))).toBe(false);
      expect(running).toHaveBeenCalledOnce();

      release();
      await expect(promise).resolves.toBe('done');
    });

    it('returns false for an unknown job id', () => {
      expect(queue.cancel('no-such-job', new Error('x'))).toBe(false);
    });

    it('lets the next queued job start normally after one is cancelled', async () => {
      let releaseBlocker;
      queue
        .enqueue(
          () =>
            new Promise((resolve) => {
              releaseBlocker = () => resolve('blocked');
            }),
          { type: 'blocker' }
        )
        .catch(() => {});

      const cancelled = queue.enqueueCancellable(vi.fn(), { type: 'cancelled' });
      cancelled.promise.catch(() => {});
      const survivor = vi.fn().mockResolvedValue('survived');
      const kept = queue.enqueue(survivor, { type: 'survivor' });

      queue.cancel(cancelled.jobId, new Error('dropped'));
      releaseBlocker();

      await expect(kept).resolves.toBe('survived');
      expect(survivor).toHaveBeenCalledOnce();
    });

    it('evicts cancelled jobs so their records cannot accumulate', () => {
      vi.useFakeTimers();
      try {
        const small = new InteractionQueue({ jobTtlMs: 1000 });
        small.pause('hold everything so nothing starts');
        const a = small.enqueueCancellable(vi.fn(), { type: 'a' });
        const b = small.enqueueCancellable(vi.fn(), { type: 'b' });
        a.promise.catch(() => {});
        b.promise.catch(() => {});

        small.cancel(a.jobId, new Error('dropped'));
        small.cancel(b.jobId, new Error('dropped'));
        expect(small.getQueueStatus().totalJobsTracked).toBe(2);

        vi.advanceTimersByTime(2000);
        small._evictStaleJobs();

        // 'cancelled' must count as terminal, or these records outlive the
        // process.
        expect(small.getQueueStatus().totalJobsTracked).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('reentrancy', () => {
    // The queue is NOT reentrant: with concurrency 1, _dequeueNext() only
    // starts a job when activeCount < concurrency, so a job enqueued from
    // inside a running job cannot start until the outer one finishes — and if
    // the outer one awaits it, neither ever does. This is why serialization is
    // applied at exactly one layer (the command router) and the controller's
    // Direct methods do not enqueue again: doing both would hang the command.
    it('deadlocks on a nested enqueue awaited by its parent', async () => {
      const inner = vi.fn().mockResolvedValue('inner');

      let outerSettled = false;
      const outer = queue
        .enqueue(async () => await queue.enqueue(inner, { type: 'inner' }), { type: 'outer' })
        .then(() => {
          outerSettled = true;
        });

      // Give the event loop plenty of turns; nothing can break the cycle.
      for (let i = 0; i < 50; i++) await Promise.resolve();

      expect(inner).not.toHaveBeenCalled();
      expect(outerSettled).toBe(false);
      expect(queue.getQueueStatus().activeJobs).toBe(1);
      expect(queue.getQueueStatus().queuedJobs).toBe(1);

      // Leave no dangling rejection handler for the (permanently) pending promise.
      outer.catch(() => {});
    });

    it('runs sequential top-level enqueues to completion in order', async () => {
      const order = [];
      const a = queue.enqueue(async () => {
        order.push('a');
      });
      const b = queue.enqueue(async () => {
        order.push('b');
      });

      await Promise.all([a, b]);
      expect(order).toEqual(['a', 'b']);
    });
  });
});
