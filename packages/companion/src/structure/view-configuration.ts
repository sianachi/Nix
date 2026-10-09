import { viewConfigurationSchema } from '@nix/api-client';
import type { StructureFilter, StructureView } from '@nix/structure-spec';
import { z } from 'zod';

// Core's FilterRuleContracts.RefuseShape requires a value even for valueless operators: ''.
const condition = z.object({ property: z.string(), operator: z.string(), value: z.string() });
const integer = (value: string | number): number => z.number().int().parse(Number(value));

/** Preserve every current stored setting when a view is read for a fenced refinement. */
export function parseStructureView(raw: unknown): StructureView {
  const view = viewConfigurationSchema.parse(raw);
  return {
    ...view,
    filters: view.filters.map((rule) =>
      rule.any !== null
        ? {
            property: null,
            operator: null,
            value: null,
            any: rule.any.map((entry): StructureFilter => condition.parse(entry)),
          }
        : condition.parse(rule),
    ),
    companionPlacement: z.enum(['below', 'beside']).nullable().parse(view.companionPlacement),
    habitWidgets: view.habitWidgets.map((widget) => ({
      ...widget,
      kind: z.enum(['completion', 'quantity', 'heatmap']).parse(widget.kind),
    })),
    groupLimits: view.groupLimits.map((limit) => ({ ...limit, limit: integer(limit.limit) })),
    chart:
      view.chart === null
        ? null
        : {
            ...view.chart,
            lastPeriods: view.chart.lastPeriods === null ? null : integer(view.chart.lastPeriods),
          },
  };
}
