import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * What this service reports about itself.
 *
 * A private registry rather than the global default, matching the collaboration service: a global
 * one is shared state a test cannot isolate, and two suites registering the same metric name throw.
 *
 * **No per-item or per-tenant labels.** Cardinality is what turns a metrics endpoint into an outage,
 * and an export's identity belongs in a log line rather than in a time series. Format and outcome
 * are both small closed sets.
 */

export interface MediaMetrics {
  readonly registry: Registry;

  /** Outcome is one of: produced, refused, timed-out, too-large, busy. */
  readonly exports: Counter<'format' | 'outcome'>;
  readonly exportSeconds: Histogram<'format'>;
  readonly exportBytes: Histogram<'format'>;
  readonly activeExports: Gauge;

  /**
   * Which losses people actually hit.
   *
   * The one metric here that is about the product rather than the process: it turns "which of these
   * lossy mappings should we fix first" from an opinion into a number.
   */
  readonly lossEntries: Counter<'kind'>;

  readonly admissionsRefused: Counter;
}

export function createMetrics(): MediaMetrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'nix_media_' });

  return {
    registry,
    exports: new Counter({
      name: 'nix_media_exports_total',
      help: 'Exports attempted, by format and outcome.',
      labelNames: ['format', 'outcome'] as const,
      registers: [registry],
    }),
    exportSeconds: new Histogram({
      name: 'nix_media_export_seconds',
      help: 'How long a conversion took.',
      labelNames: ['format'] as const,
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [registry],
    }),
    exportBytes: new Histogram({
      name: 'nix_media_export_bytes',
      help: 'How large the produced file was.',
      labelNames: ['format'] as const,
      buckets: [10_000, 100_000, 1_000_000, 10_000_000, 64_000_000],
      registers: [registry],
    }),
    activeExports: new Gauge({
      name: 'nix_media_active_exports',
      help: 'Conversions running right now.',
      registers: [registry],
    }),
    lossEntries: new Counter({
      name: 'nix_media_loss_entries_total',
      help: 'Losses recorded while converting, by kind.',
      labelNames: ['kind'] as const,
      registers: [registry],
    }),
    admissionsRefused: new Counter({
      name: 'nix_media_admissions_refused_total',
      help: 'Exports refused because the service was already at its concurrency limit.',
      registers: [registry],
    }),
  };
}
