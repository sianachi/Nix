import { items } from '@nix/api-client';
import {
  compileEntries,
  entriesSpecSchema,
  validateSpec,
  type EntriesSpec,
  type Step,
  type StructureProperty,
} from '@nix/structure-spec';
import type { CreateItemRequestContract } from '@nix/api-client';
import type { CompanionPorts } from '../ports.js';

export function compile(spec: EntriesSpec, parentId: string): Step[] {
  return compileEntries(spec, { parentId });
}

export interface CreateEntriesResult {
  created: { index: number; id: string }[];
  failed?: { index: number; reason: string };
  notAttempted: number[];
  instruction: 'Do not recreate the created entries.';
  contentConfirmed?: false;
}

export async function execute(
  ports: CompanionPorts,
  workspaceId: string,
  parentId: string,
  rawSpec: unknown,
  inheritedFields: StructureProperty[],
  signal: AbortSignal,
): Promise<CreateEntriesResult> {
  const spec = entriesSpecSchema.parse(rawSpec);
  const validation = validateSpec('create_entries', spec, {
    inheritedFields,
    today: ports.clock.today(),
  });
  if (!validation.ok)
    throw new Error(
      validation.problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n'),
    );

  const steps = compile(spec, parentId);
  const created: CreateEntriesResult['created'] = [];
  for (let index = 0; index < spec.entries.length; index += 1) {
    const entry = spec.entries[index];
    const createStepIndex = steps.findIndex(
      (candidate) =>
        candidate.kind === 'createItem' && candidate.nodeId === `entry-${String(index)}`,
    );
    const createStep = steps[createStepIndex];
    if (entry === undefined || createStep?.kind !== 'createItem')
      throw new Error('create_entries compiled to an unexpected plan.');
    let item: { id: string };
    try {
      const body: CreateItemRequestContract = {
        type: 'note',
        title: createStep.title,
        parentId: createStep.parentId,
        properties: createStep.properties,
      };
      item = await ports.core.execute(
        items.createItem(workspaceId, {
          type: body.type,
          title: body.title,
          parentId: body.parentId,
          ...(body.properties !== null ? { properties: body.properties } : {}),
        }),
        { signal, forceRefresh: true },
      );
    } catch (error) {
      return {
        created,
        failed: {
          index,
          reason: error instanceof Error ? error.message : 'The item could not be created.',
        },
        notAttempted: spec.entries.slice(index + 1).map((_, offset) => index + offset + 1),
        instruction: 'Do not recreate the created entries.',
      };
    }
    created.push({ index, id: item.id });
    if (entry.markdown) {
      try {
        await ports.bodies.append(item.id, entry.markdown, signal);
      } catch {
        return {
          created,
          failed: { index, reason: 'The entry was created but its body was not confirmed.' },
          notAttempted: spec.entries.slice(index + 1).map((_, offset) => index + offset + 1),
          instruction: 'Do not recreate the created entries.',
          contentConfirmed: false,
        };
      }
    }
  }
  return { created, notAttempted: [], instruction: 'Do not recreate the created entries.' };
}
