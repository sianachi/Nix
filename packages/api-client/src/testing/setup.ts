/**
 * Vitest global setup: the MSW lifecycle. Unhandled requests are an error, so
 * a missing handler surfaces as a failing test rather than a real network call.
 */

import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server.js';

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
