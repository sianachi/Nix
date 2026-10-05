/**
 * The MSW server shared by every test in this package.
 *
 * Tests register handlers per case with `server.use(...)`; unhandled requests
 * fail the run (see `setup.ts`), so a test can never accidentally pass because
 * a request silently went nowhere. When Core's OpenAPI document lands, the
 * handler factories generated from it plug in here unchanged.
 */

import { setupServer } from 'msw/node';

export const server = setupServer();

export const TEST_BASE_URL = 'http://nix.test/api';

export function testUrl(path: string): string {
  return `${TEST_BASE_URL}${path}`;
}
