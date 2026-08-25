/**
 * A signal that never aborts, for a run that was given none. Having one lets the
 * rest of the SDK take an `AbortSignal` unconditionally instead of threading an
 * optional through every step kind.
 */
export const NEVER_ABORTS: AbortSignal = new AbortController().signal;

/** A step exceeded its declared `timeout`. */
export class StepTimeoutError extends Error {
  readonly stepName: string;
  readonly timeoutMs: number;

  constructor(stepName: string, timeoutMs: number) {
    super(`Step "${stepName}" timed out after ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
    this.stepName = stepName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `work` under the run's abort signal, plus a deadline of its own when the step
 * declared one.
 *
 * Enforced here, once, rather than by each step kind: a `code` step has no process to
 * kill and would otherwise ignore `timeout` entirely. Racing the deadline against the
 * work is what bounds a step whose body never looks at the signal it was handed —
 * cancellation is cooperative, so the signal alone is not enough.
 */
export async function withTimeout<T>(
  stepName: string,
  timeoutMs: number | undefined,
  runSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) return work(runSignal);

  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new StepTimeoutError(stepName, timeoutMs)), timeoutMs);
  const signal = AbortSignal.any([runSignal, clock.signal]);
  try {
    return await Promise.race([work(signal), rejectWhenAborted(signal)]);
  } catch (error) {
    // Work cancelled by the deadline usually rejects with its own cancellation error
    // first; the timeout is the honest attribution.
    throw clock.signal.aborted ? clock.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
