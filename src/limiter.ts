/** Counting semaphore used to bound how many steps of a group run at once. */
export class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  /**
   * `Infinity` is the deliberate way to say unbounded. Zero and negatives are not: a
   * caller that computed one from a config value means "as few as possible", and running
   * the whole group at once is the furthest thing from it — so they are refused here
   * rather than silently turned into the most dangerous reading.
   */
  constructor(private readonly limit: number) {
    if (Number.isNaN(limit) || limit < 1) {
      throw new RangeError(
        `concurrency must be at least 1, or Infinity for unbounded; got ${limit}`,
      );
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!Number.isFinite(this.limit)) return fn();
    // `while`, not `if`: releasing a slot decrements `active` and only *then* wakes a
    // waiter, so a caller arriving in between can take the slot first. A woken waiter
    // has to re-check rather than assume the slot it was promised is still free.
    while (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}
