/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- Node executes this module directly without TypeScript syntax; the exported evidence contracts are typed in JSDoc. */

/** @typedef {{ cycle: number, usedBytes: number }} HeapSample */
/**
 * Returns the least-squares heap trend in bytes per completed mount cycle.
 * @param {readonly HeapSample[]} samples
 * @returns {number}
 */
export function heapSlope(samples) {
  if (samples.length < 2) return 0;
  const meanCycle = samples.reduce((total, sample) => total + sample.cycle, 0) / samples.length;
  const meanBytes = samples.reduce((total, sample) => total + sample.usedBytes, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const distance = sample.cycle - meanCycle;
    numerator += distance * (sample.usedBytes - meanBytes);
    denominator += distance * distance;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Validates that repeated-view memory evidence is comparable, complete and within budget.
 * @param {{
 *   supported?: boolean,
 *   normalizedView?: string | null,
 *   cycles?: number,
 *   samples?: HeapSample[],
 *   beforeBytes?: number,
 *   afterBytes?: number,
 *   deltaBytes?: number,
 *   maximumGrowthBytes?: number,
 *   slopeBytesPerCycle?: number
 * }} memory
 * @param {{ maximumHeapGrowthBytes: number, maximumHeapSlopeBytesPerCycle: number }} budgets
 * @returns {string[]}
 */
export function memoryEvidenceFailures(memory, budgets) {
  const failures = [];
  if (memory.supported !== true) {
    return ['precise browser heap measurement was unavailable'];
  }
  if (typeof memory.normalizedView !== 'string' || memory.normalizedView.length === 0) {
    failures.push('memory samples were not normalized to one view');
  }
  if (!Number.isInteger(memory.cycles) || memory.cycles < 3) {
    failures.push('memory evidence did not include at least three measured cycles');
  }
  if (!Array.isArray(memory.samples) || memory.samples.length !== memory.cycles + 1) {
    failures.push('memory evidence did not include a baseline and one sample per cycle');
    return failures;
  }

  const validSamples = memory.samples.every(
    (sample, index) =>
      sample.cycle === index && Number.isFinite(sample.usedBytes) && sample.usedBytes >= 0,
  );
  if (!validSamples) {
    failures.push('memory samples were incomplete or out of cycle order');
    return failures;
  }

  const baseline = memory.samples[0].usedBytes;
  const final = memory.samples.at(-1).usedBytes;
  const maximumGrowth = Math.max(...memory.samples.map((sample) => sample.usedBytes - baseline));
  const slope = heapSlope(memory.samples);
  if (memory.beforeBytes !== baseline || memory.afterBytes !== final) {
    failures.push('memory summary did not match its per-cycle samples');
  }
  if (memory.deltaBytes !== Math.round(final - baseline)) {
    failures.push('memory delta did not match its normalized baseline');
  }
  if (memory.maximumGrowthBytes !== Math.round(maximumGrowth)) {
    failures.push('memory peak growth did not match its per-cycle samples');
  }
  if (Math.abs(memory.slopeBytesPerCycle - slope) > 1) {
    failures.push('memory slope did not match its per-cycle samples');
  }
  if (maximumGrowth > budgets.maximumHeapGrowthBytes) {
    failures.push(`heap grew by as much as ${String(Math.round(maximumGrowth))} bytes`);
  }
  if (slope > budgets.maximumHeapSlopeBytesPerCycle) {
    failures.push(`heap trend was ${String(Math.round(slope))} bytes per cycle`);
  }
  return failures;
}
