import { structure } from '@nix/api-client';
import { compileEditFields, type Step } from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';

export const compile = compileEditFields;

export async function execute(
  ports: CompanionPorts,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<unknown> {
  const step = steps[0];
  if (steps.length !== 1 || step?.kind !== 'setItemSchema')
    throw new Error('Unexpected field edit plan.');
  return ports.core.execute(
    structure.setItemSchema(step.itemId, {
      inherit: step.schema.inherit,
      properties: step.schema.properties.map((property) => ({
        ...property,
        expression: property.expression ?? null,
        aggregate: property.aggregate ?? null,
        source: property.source ?? null,
      })),
    }),
    { signal, forceRefresh: true },
  );
}
