import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The engine's determinism is a contract, not a habit: the collaboration
 * service refuses updates it cannot re-evaluate to the same values the
 * editor saw. Wall clocks, randomness, and I/O are how that contract breaks,
 * so their absence is asserted rather than assumed.
 */
describe('engine purity', () => {
  it('holds no clock, randomness, network, or filesystem access', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(0);
    const banned = [/\bDate\b/, /Math\.random/, /\bfetch\s*\(/, /from 'node:/, /require\(/];
    for (const name of sources) {
      const text = readFileSync(join(here, name), 'utf8');
      for (const pattern of banned) {
        expect(pattern.test(text), `${name} matches ${String(pattern)}`).toBe(false);
      }
    }
  });
});
