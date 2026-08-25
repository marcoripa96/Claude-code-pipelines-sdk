/** Counting semaphore used to bound how many steps of a group run at once. */
export class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!Number.isFinite(this.limit) || this.limit <= 0) return fn();
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
