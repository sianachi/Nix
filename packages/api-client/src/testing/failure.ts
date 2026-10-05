/**
 * Test helper: await a call that must fail and get back the typed error.
 *
 * Keeping this in one place stops tests from asserting on `unknown` with a
 * cast per assertion, and makes "it failed with the wrong kind of error" a
 * clear failure rather than a confusing type complaint.
 */

import { isNixApiError, type NixApiError } from '../errors.js';

export async function captureFailure(promise: Promise<unknown>): Promise<NixApiError> {
  try {
    await promise;
  } catch (error) {
    if (isNixApiError(error)) return error;
    throw error;
  }
  throw new Error('Expected the call to fail, but it resolved');
}
