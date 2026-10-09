import { z } from 'zod';
import { LIMITS } from '@nix/structure-spec';

export const MAX_STRUCTURE_READ_TEXT = 16000;
const priority = [
  'id',
  'name',
  'kind',
  'key',
  'type',
  'canRender',
  'isDefault',
  'problems',
  'inherited',
  'computed',
  'required',
  'groupBy',
  'dateProperty',
  'doneProperty',
  'rowBy',
  'companionViewId',
  'companionPlacement',
  'chart',
  'filters',
  'sorts',
  'columns',
  'visibleWhen',
  'propertyKey',
  'identityRole',
];
const references = new Set([
  'id',
  'itemId',
  'workspaceId',
  'containerId',
  'key',
  'type',
  'kind',
  'propertyKey',
  'fieldBlockId',
  'titleFieldBlockId',
  'viewId',
  'defaultView',
  'default',
  'groupBy',
  'dateProperty',
  'endDateProperty',
  'doneProperty',
  'rowBy',
  'companionViewId',
  'measureProperty',
  'sortBy',
  'coverProperty',
  'property',
  'splitBy',
  'columns',
  'source',
  'operator',
  'value',
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compact(value: unknown, textLimit: number, arrayLimit: number, key = ''): unknown {
  if (typeof value === 'string')
    return references.has(key) || value.length <= textLimit
      ? value
      : `${value.slice(0, textLimit)} [text omitted]`;
  if (Array.isArray(value)) {
    const ceiling =
      key === 'views' ? LIMITS.viewsPerContainer : key === 'fields' ? 256 : arrayLimit;
    return value
      .slice(0, ceiling)
      .map((entry: unknown) => compact(entry, textLimit, arrayLimit, key));
  }
  const record = object(value);
  if (record === null) return value;
  const ordered = [
    ...new Set([...priority.filter((field) => field in record), ...Object.keys(record)]),
  ];
  // Every known setting remains present here. Property bags are bounded separately: removing a
  // configuration key silently would be worse than explicitly summarising that configuration.
  const keys = key === 'properties' ? ordered.slice(0, arrayLimit) : ordered;
  return Object.fromEntries(
    keys.map((field) => [field, compact(record[field], textLimit, arrayLimit, field)]),
  );
}

/** Keeps truncation machine-readable. Metadata survives even when form text or item values are
 * much larger than the tool budget; an incomplete configuration is never passed off as complete. */
export function boundedStructureRead(
  operation: 'read_structure' | 'read_view',
  result: unknown,
): string {
  const full = JSON.stringify(result);
  if (full.length <= MAX_STRUCTURE_READ_TEXT) return full;
  const raw = z.record(z.string(), z.unknown()).parse(result);
  const originalLimits = Array.isArray(raw.limits)
    ? raw.limits.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const limit =
    'The tool output budget omitted or shortened configuration text, collections or property values. Configuration and samples are partial; omitted values are unknown, not empty. Read a single view or a smaller sample for more detail.';
  const finish = (candidate: Record<string, unknown>): string => {
    if (Array.isArray(candidate.results)) candidate.returned = candidate.results.length;
    if (candidate.source === 'chart') {
      const chart = object(candidate.chart);
      if (chart !== null && Array.isArray(chart.buckets)) candidate.returned = chart.buckets.length;
    }
    return JSON.stringify({
      ...candidate,
      truncated: true,
      configurationTruncated: true,
      outputTruncated: true,
      limits: [...originalLimits, limit],
    });
  };
  for (const [textLimit, arrayLimit] of [
    [256, 25],
    [96, 12],
    [32, 4],
  ] as const) {
    const candidate = z.record(z.string(), z.unknown()).parse(compact(raw, textLimit, arrayLimit));
    const text = finish(candidate);
    if (text.length <= MAX_STRUCTURE_READ_TEXT) return text;
  }

  // A pathological wide schema or form needs an explicit summary. Preserve the source decisions,
  // field types and all bounded view identities before spending room on long field options/text.
  const metadataKeys = [
    'item',
    'source',
    'today',
    'timeZone',
    'appliedViewRules',
    'totalCount',
    'nextCursor',
    'hasUnboundedProvenance',
    'defaultView',
    'hideDocument',
    'inheritsFields',
    'childCount',
    'viewCapacity',
  ];
  let summary = Object.fromEntries(
    metadataKeys.filter((key) => key in raw).map((key) => [key, compact(raw[key], 64, 4, key)]),
  );
  const summarizeView = (value: unknown): unknown => {
    const view = object(value);
    if (view === null) return null;
    const keys = [
      'id',
      'name',
      'kind',
      'canRender',
      'isDefault',
      'problems',
      'groupBy',
      'dateProperty',
      'doneProperty',
      'rowBy',
      'companionViewId',
      'companionPlacement',
    ];
    return Object.fromEntries(
      keys.filter((key) => key in view).map((key) => [key, compact(view[key], 64, 4, key)]),
    );
  };
  if (operation === 'read_structure') {
    summary.views = Array.isArray(raw.views)
      ? raw.views.slice(0, LIMITS.viewsPerContainer).map(summarizeView)
      : [];
    summary.fields = Array.isArray(raw.fields)
      ? raw.fields.slice(0, 64).map((value: unknown) => {
          const field = object(value);
          return field === null
            ? null
            : {
                key: compact(field.key, 64, 4, 'key'),
                type: compact(field.type, 64, 4, 'type'),
                inherited: field.inherited,
                computed: field.computed,
                required: field.required,
              };
        })
      : [];
  } else {
    summary.view = summarizeView(raw.view);
    summary.results = [];
    summary.returned = 0;
  }
  let text = finish(summary);
  if (text.length <= MAX_STRUCTURE_READ_TEXT) return text;
  const finalLimits = [
    ...originalLimits
      .slice(0, 8)
      .map((entry) =>
        entry.length <= 1024 ? entry : `${entry.slice(0, 1024)} [diagnostic omitted]`,
      ),
    limit,
  ];
  const renderSummary = (): string =>
    JSON.stringify({
      ...summary,
      truncated: true,
      configurationTruncated: true,
      outputTruncated: true,
      limits: finalLimits,
    });
  text = renderSummary();
  for (const key of ['fields', 'views']) {
    const entries = summary[key];
    if (!Array.isArray(entries)) continue;
    while (text.length > MAX_STRUCTURE_READ_TEXT && entries.length > 0) {
      entries.pop();
      text = renderSummary();
    }
  }
  // Never invent an identifier by clipping it. An impossible oversized reference is omitted
  // with the partial-state markers instead, even for unexpected non-contract input.
  for (const key of Object.keys(summary)) {
    if (text.length <= MAX_STRUCTURE_READ_TEXT) break;
    summary = Object.fromEntries(Object.entries(summary).filter(([field]) => field !== key));
    text = renderSummary();
  }
  return text;
}
