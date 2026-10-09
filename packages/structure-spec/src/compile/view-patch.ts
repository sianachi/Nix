import type { UpdateViewSpec } from '../spec/update-view.js';
import type { StructureChartOptions, StructureView } from '../types.js';

const emptyChart: StructureChartOptions = {
  kind: null,
  period: null,
  splitBy: null,
  lastPeriods: null,
  from: null,
  to: null,
  cumulative: null,
  rollingAverage: null,
  stacked: null,
};

/** Carries every omitted setting through, including settings outside the pet's patch vocabulary. */
export function applyViewPatch(view: StructureView, spec: UpdateViewSpec): StructureView {
  const patch = Object.fromEntries(
    Object.entries(spec.patch).filter(([, value]) => value !== undefined),
  ) as UpdateViewSpec['patch'];
  const { chart, filters, ...plain } = patch;
  // The strict spec has checked these field types; filtering above removes explicit undefined
  // too, which the optional Zod input type cannot express to an exact-optional TypeScript spread.
  const updated = { ...view, ...plain } as StructureView;
  if (chart !== undefined) {
    const supplied =
      chart === null
        ? null
        : (Object.fromEntries(
            Object.entries(chart).filter(([, value]) => value !== undefined),
          ) as Partial<StructureChartOptions>);
    updated.chart = supplied === null ? null : { ...(view.chart ?? emptyChart), ...supplied };
  }
  if (filters !== undefined) {
    updated.filters = filters.map((entry) =>
      'any' in entry ? { property: null, operator: null, value: null, any: entry.any } : entry,
    );
  }
  // Core mirrors the first entry of sorts back onto sortBy and sortDescending. Updating just
  // the legacy fields would therefore lose the requested change on any view with stored sorts.
  if (patch.sortBy !== undefined || patch.sortDescending !== undefined) {
    updated.sorts =
      updated.sortBy === null
        ? []
        : [
            { property: updated.sortBy, descending: updated.sortDescending },
            ...(view.sorts ?? []).slice(1).filter((sort) => sort.property !== updated.sortBy),
          ];
  }
  return updated;
}
