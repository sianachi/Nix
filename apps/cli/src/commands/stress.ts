/**
 * `nixctl stress seed`: populate a container with children, at the scale the stress rows name.
 *
 * The whole point of the CLI's stress surface is that the scale runs cost no model tokens: a script
 * seeds the 3,000+ children §1.9, §2.5 and §3.13 ask for and reads them back, and no agent walks the
 * tree by hand. This is the seed half — it composes the `item create` primitive rather than adding a
 * new endpoint, so it inherits the same authorization and the same refusals.
 *
 * **It stops honestly on the write rate limit rather than grinding.** Writes are capped per IP
 * (`Nix:RateLimits:WritesPerMinute`, 120 by default), so a large seed will meet a 429; when it does,
 * the command stops and names the override to raise on the stack, and reports exactly how many
 * children it made — a partial seed said plainly, never a hang or a silent stall.
 */

import { isNixApiError, items, search, itemQuery as queries } from '@nix/api-client';
import { resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';

/** The override to name when the seed meets the write rate limit, so a person can raise it. */
const WRITES_LIMIT_OVERRIDE = 'Nix__RateLimits__WritesPerMinute';

export interface SeedOptions {
  readonly workspaceId: string;
  readonly count: number;
  /** The container to seed under; a new one is created when omitted. */
  readonly parentId?: string | undefined;
  readonly titlePrefix?: string | undefined;
  readonly type?: string | undefined;
}

/** Seeds `count` children under a container (creating one when none is given) and reports the count. */
export async function seed(
  profileName: string | undefined,
  options: SeedOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (!Number.isInteger(options.count) || options.count < 1) {
    throw new Error(`--count must be a positive integer, got '${String(options.count)}'.`);
  }

  const session = await resolveSession(profileName, deps);
  const type = options.type ?? 'note';
  const prefix = options.titlePrefix ?? 'Item';

  // Create the parent first when one was not given, so the seed always has a container to hang the
  // children on. A note holds children like any item, so this needs no special "folder" kind.
  const parentId =
    options.parentId ??
    (
      await session.client.execute(
        items.createItem(options.workspaceId, {
          type: 'note',
          title: `Stress seed (${String(options.count)})`,
        }),
      )
    ).id;

  let created = 0;
  let stoppedEarly = false;
  let reason: string | undefined;

  for (let index = 0; index < options.count; index += 1) {
    try {
      await session.client.execute(
        items.createItem(options.workspaceId, {
          type,
          title: `${prefix} ${String(index + 1)}`,
          parentId,
        }),
      );
      created += 1;
    } catch (error) {
      // The write rate limit is an expected outcome of seeding at scale, not a bug: stop, keep what
      // was made, and name the override. Anything else is a real failure and propagates.
      if (isNixApiError(error) && error.status === 429) {
        stoppedEarly = true;
        reason = `Hit the write rate limit after ${String(created)} children. Raise ${WRITES_LIMIT_OVERRIDE} on the stack to seed faster.`;
        break;
      }
      throw error;
    }
  }

  printResult(
    {
      workspaceId: options.workspaceId,
      parentId,
      requested: options.count,
      created,
      stoppedEarly,
      ...(reason !== undefined ? { reason } : {}),
    },
    output,
  );
}

/** The scenarios `stress run` knows. Others are named where planned so an unknown one rejects clearly. */
export const KNOWN_SCENARIOS = ['read-storm', 'search-storm', 'query-storm'] as const;
export type Scenario = (typeof KNOWN_SCENARIOS)[number];

export interface RunOptions {
  readonly scenario: string;
  readonly iterations: number;
  /** read-storm and query-storm: the item to read (a container, for query-storm). */
  readonly itemId?: string | undefined;
  /** search-storm: the query to run each iteration. */
  readonly query?: string | undefined;
  /** search-storm: the optional result cap. */
  readonly limit?: number | undefined;
  /** query-storm: which of the container's views to run. */
  readonly viewId?: string | undefined;
  /** query-storm: the caller's own day (`yyyy-MM-dd`) for relative rules. */
  readonly today?: string | undefined;
}

interface StormTally {
  readonly ok: number;
  readonly errors: number;
  readonly errorsByCode: Record<string, number>;
  readonly durations: number[];
}

/**
 * The scenario-agnostic core of a storm: run one read `iterations` times, time each with the given
 * clock, and tally successes and failures. A failure is counted by its problem code and the loop
 * keeps going — reads are not rate-limited, so a blip is a genuine result to record, and a report
 * that stops at the first one measures nothing.
 */
async function storm(
  readOnce: () => Promise<unknown>,
  iterations: number,
  now: () => number,
): Promise<StormTally> {
  const durations: number[] = [];
  const errorsByCode: Record<string, number> = {};
  let ok = 0;
  let errors = 0;

  for (let index = 0; index < iterations; index += 1) {
    const start = now();
    try {
      await readOnce();
      durations.push(now() - start);
      ok += 1;
    } catch (error) {
      errors += 1;
      const code = isNixApiError(error) ? error.code : 'unknown';
      errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
    }
  }

  return { ok, errors, errorsByCode, durations };
}

/**
 * `stress run --scenario <name>`: repeat a read many times and report the latency spread.
 *
 * `read-storm` (one item), `search-storm` (one query) and `query-storm` (one container view) all
 * force past the client cache, so every iteration is a real round trip rather than a cache hit — the
 * whole point of a *storm*. Adding a scenario is adding one `readOnce` closure below — the loop, the
 * tally and the report do not change.
 *
 * **The latency numbers are only meaningful against a live stack.** Under the test's instant mocks
 * they exercise the harness — the counting, the error tally, the percentile maths (proved with an
 * injected clock) — not real latency. That distinction is the point of §2.3's honesty rule.
 */
export async function stressRun(
  profileName: string | undefined,
  options: RunOptions,
  output: OutputOptions,
  deps: SessionDeps & { readonly now?: () => number } = {},
): Promise<void> {
  if (!KNOWN_SCENARIOS.includes(options.scenario as Scenario)) {
    throw new Error(
      `Unknown scenario '${options.scenario}'. Available: ${KNOWN_SCENARIOS.join(', ')}.`,
    );
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error(`--iterations must be a positive integer, got '${String(options.iterations)}'.`);
  }

  const session = await resolveSession(profileName, deps);
  const now = deps.now ?? Date.now;

  let readOnce: () => Promise<unknown>;
  let target: string;
  if (options.scenario === 'read-storm') {
    const itemId = options.itemId;
    if (itemId === undefined) {
      throw new Error('read-storm needs --item <id>.');
    }
    readOnce = () => session.client.query(items.itemById(itemId), { forceRefresh: true });
    target = itemId;
  } else if (options.scenario === 'search-storm') {
    const query = options.query;
    if (query === undefined) {
      throw new Error('search-storm needs --query <text>.');
    }
    const limit = options.limit;
    // forceRefresh here too: an undefined cacheKey means "key by the request", not "do not cache",
    // so without it the second identical query would be served from the client cache and the storm
    // would hit the index exactly once.
    readOnce = () => session.client.query(search.searchItems(query, limit), { forceRefresh: true });
    target = query;
  } else {
    const itemId = options.itemId;
    const viewId = options.viewId;
    const today = options.today;
    if (itemId === undefined || viewId === undefined || today === undefined) {
      throw new Error('query-storm needs --item <id>, --view <viewId> and --today <yyyy-mm-dd>.');
    }
    readOnce = () =>
      session.client.query(queries.itemQuery(itemId, viewId, today), { forceRefresh: true });
    target = `${itemId}#${viewId}`;
  }

  const tally = await storm(readOnce, options.iterations, now);
  const sorted = [...tally.durations].sort((left, right) => left - right);
  printResult(
    {
      scenario: options.scenario,
      target,
      iterations: options.iterations,
      ok: tally.ok,
      errors: tally.errors,
      errorsByCode: tally.errorsByCode,
      latencyMs: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: percentile(sorted, 100),
      },
    },
    output,
  );
}

/**
 * The nearest-rank percentile of an ascending-sorted sample, or 0 for an empty one.
 *
 * Nearest-rank rather than interpolation on purpose: a latency report should quote a value that
 * actually occurred, and with the small samples a stress run produces, interpolating between two
 * measurements invents a number no request ever saw.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index] ?? 0;
}
