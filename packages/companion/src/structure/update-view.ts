import { views } from '@nix/api-client';
import {
  compileUpdateView,
  type UpdateViewSpec,
  type StructureProperty,
  type StructureView,
  type Step,
} from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';
import { toViewRequest } from './create-structured.js';

export function compile(
  spec: UpdateViewSpec,
  context: {
    itemId: string;
    existing: {
      declared: StructureProperty[];
      effective: StructureProperty[];
      inherit: boolean;
      views: StructureView[];
      defaultViewId?: string;
      hideDocument?: boolean;
      version?: string;
    };
  },
): Step[] {
  return compileUpdateView(spec, context);
}

export async function execute(
  ports: CompanionPorts,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<unknown> {
  const step = steps[0];
  if (
    steps.length !== 1 ||
    step?.kind !== 'replaceViewSetup' ||
    !step.viewUpdate ||
    step.schema.properties.length > 0 ||
    step.originalPropertyKeys.length > 0 ||
    !step.expectedVersion ||
    !/^[a-f0-9]{64}$/.test(step.expectedVersion)
  )
    throw new Error('update_view compiled to an unexpected plan.');
  return ports.core.execute(
    views.setContainerViews(step.itemId, {
      views: step.views.map(toViewRequest),
      default: step.defaultViewId ?? null,
      hideDocument: step.hideDocument ?? false,
      expectedVersion: step.expectedVersion,
    }),
    { signal, forceRefresh: true },
  );
}
