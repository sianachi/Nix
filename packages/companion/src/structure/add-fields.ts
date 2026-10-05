import { views, type AppendViewSetupRequestContract } from '@nix/api-client';
import {
  compileAddFields,
  type FieldsSpec,
  type Step,
  type StructureProperty,
} from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';
import { toPropertyDefinitionRequest, toViewRequest } from './create-structured.js';

export function compile(
  spec: FieldsSpec,
  context: {
    itemId: string;
    existing: {
      effective: StructureProperty[];
    };
  },
): Step[] {
  return compileAddFields(spec, context);
}

export async function execute(
  ports: CompanionPorts,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<unknown> {
  const step = steps[0];
  if (steps.length !== 1 || step?.kind !== 'appendViewSetup') {
    throw new Error('add_fields compiled to an unexpected plan.');
  }

  const body: AppendViewSetupRequestContract = {
    properties: step.properties.map(toPropertyDefinitionRequest),
    views: step.views.map(toViewRequest),
    makeDefault: step.makeDefault,
    publishInteractiveFormViewId: null,
  };
  return ports.core.execute(views.appendViewSetup(step.itemId, body), {
    signal,
    forceRefresh: true,
  });
}
