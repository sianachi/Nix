import { updateViewSpecSchema, type UpdateViewSpec } from '../spec/update-view.js';
import type { StructureProperty, StructureView } from '../types.js';
import { validateUpdateView } from '../validate/update-view.js';
import { applyViewPatch } from './view-patch.js';
import type { Step } from './steps.js';

export interface UpdateViewContext {
  itemId: string;
  existing: {
    declared?: readonly StructureProperty[];
    effective: readonly StructureProperty[];
    inherit: boolean;
    views: readonly StructureView[];
    defaultViewId?: string | null;
    hideDocument?: boolean;
    version?: string;
  };
}

/** Carries the full ordered set through the single views command, changing only the target. */
export function compileUpdateView(spec: UpdateViewSpec, context: UpdateViewContext): Step[] {
  const parsed = updateViewSpecSchema.parse(spec);
  const declared = context.existing.declared ?? [];
  const declaredKeys = new Set(declared.map((field) => field.key));
  const report = validateUpdateView(parsed, {
    inheritedFields: context.existing.effective.filter((field) => !declaredKeys.has(field.key)),
    existing: { ...context.existing, declared: [...declared], views: [...context.existing.views] },
    today: '',
  });
  if (!report.ok) throw new Error(report.problems.map((problem) => problem.message).join(' '));
  const target = context.existing.views.find((view) => view.id === parsed.viewId);
  if (target === undefined) throw new Error(`View '${parsed.viewId}' does not exist on this item.`);
  const updated = applyViewPatch(target, parsed);
  const views = context.existing.views.map((view) => (view.id === target.id ? updated : view));
  return [
    {
      kind: 'replaceViewSetup',
      itemId: context.itemId,
      viewId: target.id,
      schema: { properties: [], inherit: context.existing.inherit },
      originalPropertyKeys: [],
      views,
      viewUpdate: true,
      defaultViewId:
        context.existing.defaultViewId === undefined ? 'document' : context.existing.defaultViewId,
      hideDocument: context.existing.hideDocument ?? false,
      ...(context.existing.version === undefined
        ? {}
        : { expectedVersion: context.existing.version }),
    },
  ];
}
