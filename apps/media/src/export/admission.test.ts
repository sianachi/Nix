import { describe, expect, it } from 'vitest';

import { createAdmission } from './admission.ts';

describe('the admission gate', () => {
  it('lets work in up to its limit', () => {
    const admission = createAdmission(2);

    expect(admission.enter()).not.toBeNull();
    expect(admission.enter()).not.toBeNull();
    expect(admission.enter()).toBeNull();
  });

  it('lets the next one in once something finishes', () => {
    const admission = createAdmission(1);
    const release = admission.enter();

    expect(admission.enter()).toBeNull();
    release?.();
    expect(admission.enter()).not.toBeNull();
  });

  it('counts a double release once, so an error path cannot raise the limit', () => {
    // A handler releasing in both a catch and a finally is the ordinary way this happens, and the
    // damage is invisible: the gate silently admits one more forever after.
    const admission = createAdmission(1);
    const release = admission.enter();

    release?.();
    release?.();

    expect(admission.enter()).not.toBeNull();
    expect(admission.enter()).toBeNull();
  });

  it('reports what is in flight, for the gauge', () => {
    const admission = createAdmission(3);
    admission.enter();
    admission.enter();

    expect(admission.inFlight).toBe(2);
  });
});
