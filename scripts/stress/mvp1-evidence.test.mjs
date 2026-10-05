import assert from 'node:assert/strict';
import test from 'node:test';

import { heapSlope, memoryEvidenceFailures } from './mvp1-evidence.mjs';

const budgets = {
  maximumHeapGrowthBytes: 8 * 1024 * 1024,
  maximumHeapSlopeBytesPerCycle: 1024 * 1024,
};

function evidence(usedBytes) {
  const samples = usedBytes.map((value, cycle) => ({ cycle, usedBytes: value }));
  const beforeBytes = usedBytes[0];
  const afterBytes = usedBytes.at(-1);
  return {
    supported: true,
    normalizedView: 'List',
    cycles: usedBytes.length - 1,
    samples,
    beforeBytes,
    afterBytes,
    deltaBytes: Math.round(afterBytes - beforeBytes),
    maximumGrowthBytes: Math.round(Math.max(...usedBytes.map((value) => value - beforeBytes))),
    slopeBytesPerCycle: heapSlope(samples),
  };
}

test('accepts a normalized heap plateau with one sample per cycle', () => {
  assert.deepEqual(
    memoryEvidenceFailures(evidence([20_000_000, 20_500_000, 20_300_000, 20_450_000]), budgets),
    [],
  );
});

test('refuses unsupported, over-budget and steadily leaking memory evidence', () => {
  assert.deepEqual(memoryEvidenceFailures({ supported: false }, budgets), [
    'precise browser heap measurement was unavailable',
  ]);

  const leaking = evidence([20_000_000, 22_000_000, 24_000_000, 26_000_000]);
  const failures = memoryEvidenceFailures(leaking, budgets);
  assert.ok(failures.some((failure) => failure.includes('heap trend')));

  const transientPeak = evidence([20_000_000, 30_000_000, 20_100_000, 20_200_000]);
  assert.ok(
    memoryEvidenceFailures(transientPeak, budgets).some((failure) => failure.includes('heap grew')),
  );
});

test('refuses summaries that omit a cycle or do not match the recorded samples', () => {
  const malformed = evidence([20_000_000, 20_100_000, 20_200_000, 20_300_000]);
  malformed.samples = malformed.samples.slice(0, -1);
  assert.ok(
    memoryEvidenceFailures(malformed, budgets).some((failure) => failure.includes('one sample')),
  );
});
