/**
 * How many conversions may run at once.
 *
 * **A CPU-bound renderer with no admission control is precisely how this process dies.** pdfmake and
 * Open XML assemble a whole document before emitting a byte, so each concurrent export holds its
 * document in memory and competes for the same single thread. Ten arriving together do not take ten
 * times as long each - they take ten times as long *and* hold ten documents, and the tenth request
 * is the one that exhausts the heap.
 *
 * Refusing the eleventh with a retry-after is the honest answer: the work is bounded, the caller is
 * told when to come back, and the ten in flight finish at the speed they would have anyway. The
 * development document names per-job resource limits as an isolation requirement, and this is the
 * one that protects the other jobs rather than the job itself.
 */

export interface Admission {
  /** A release function, or null when the gate is full. */
  enter(): (() => void) | null;

  readonly inFlight: number;
}

export function createAdmission(limit: number): Admission {
  let inFlight = 0;

  return {
    enter(): (() => void) | null {
      if (inFlight >= limit) {
        return null;
      }

      inFlight += 1;
      let released = false;

      // Idempotent: a caller that releases in both a catch and a finally would otherwise decrement
      // twice and quietly raise the effective limit for everybody after it.
      return () => {
        if (!released) {
          released = true;
          inFlight -= 1;
        }
      };
    },

    get inFlight(): number {
      return inFlight;
    },
  };
}
