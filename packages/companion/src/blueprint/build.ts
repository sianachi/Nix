import {
  habits,
  isNixApiError,
  items,
  recurrence,
  type CreateItemRequestContract,
} from '@nix/api-client';
import { isWriteStep, type Step } from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';
import { toPropertyDefinitionRequest, toViewRequest } from '../structure/create-structured.js';
import { checkItem } from '../guards.js';
import { WorkspaceToolRefusal } from '../tool-args.js';
import { createSandbox, findSandbox } from './sandbox.js';

export interface BuildResult {
  rootId: string | null;
  complete: boolean;
  ledger: {
    nodeId: string;
    step: Step['kind'];
    status: 'done' | 'failed' | 'skipped';
    itemId?: string;
  }[];
  links: string[];
  instruction: string;
  rateLimited?: boolean;
}

const COMPLETE = 'The draft is built. Suggest two or three things to try.';
const INCOMPLETE =
  'The draft is incomplete. Do not build again. Offer to move the draft to trash, then build a corrected design.';
const RATE_LIMITED =
  'The draft is incomplete because Nix limited the write rate. Do not build again. Offer to move the draft to trash and try again in a minute.';

export async function executeBuild(
  ports: CompanionPorts,
  workspaceId: string,
  plan: { steps: readonly Step[]; nodeOrder: readonly string[] },
  signal: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<BuildResult> {
  if (plan.steps.length > 80 || plan.steps.some((step) => !isWriteStep(step)))
    throw new Error('The blueprint plan exceeds the supported write budget.');
  const ledger: BuildResult['ledger'] = [];
  const nodeItems = new Map<string, string>();
  const containerNodes = new Set<string>();
  const links: string[] = [];
  let sandboxId: string | null = null;
  let rootId: string | null = null;
  let failedNode: string | null = null;
  let failedError: unknown;
  let rateLimited = false;

  // Validate the chosen parent and the workspace-scoped sandbox before any writes.
  for (const step of plan.steps) {
    if (step.kind === 'createItem' || step.kind === 'createStructuredItem') {
      if (step.parentId) await checkItem(ports, workspaceId, step.parentId, signal);
      break;
    }
  }
  const needsSandbox = plan.steps.some(
    (step) => step.kind === 'ensureSandbox' || 'sandboxParent' in step,
  );
  if (needsSandbox) sandboxId = (await findSandbox(ports, workspaceId, signal))?.id ?? null;
  const sandboxWasPlanned = plan.steps.some((step) => step.kind === 'ensureSandbox');
  if (
    sandboxId === null &&
    !sandboxWasPlanned &&
    plan.steps.some((step) => 'sandboxParent' in step)
  )
    throw new WorkspaceToolRefusal(
      'Pet drafts changed since you approved this. Review the design again before building.',
    );

  let completed = 0;
  for (const [index, raw] of plan.steps.entries()) {
    if (signal.aborted) {
      failedNode = rawNodeId(raw);
      failedError = new Error('Build cancelled.');
      ledger.push({ nodeId: failedNode, step: raw.kind, status: 'failed' });
      for (const remaining of plan.steps.slice(index + 1))
        ledger.push({ nodeId: rawNodeId(remaining), step: remaining.kind, status: 'skipped' });
      break;
    }
    try {
      let result: { id: string } | undefined;
      if (raw.kind === 'ensureSandbox') {
        sandboxId ??= (await createSandbox(ports, workspaceId, signal)).id;
        result = { id: sandboxId };
      } else if (raw.kind === 'createItem' || raw.kind === 'createStructuredItem') {
        const parentId = raw.parentNodeId
          ? nodeItems.get(raw.parentNodeId)
          : raw.sandboxParent
            ? sandboxId
            : raw.parentId;
        if (raw.parentNodeId && parentId === undefined)
          throw new Error('The blueprint parent was not created.');
        const resolvedParent = raw.sandboxParent ? sandboxId : (parentId ?? null);
        if (resolvedParent) await checkItem(ports, workspaceId, resolvedParent, signal);
        if (raw.kind === 'createStructuredItem') {
          const created = await ports.core.execute(
            items.createStructuredItem(workspaceId, {
              type: 'note',
              title: raw.title,
              parentId: resolvedParent,
              schema: {
                properties: raw.schema.properties.map(toPropertyDefinitionRequest),
                inherit: raw.schema.inherit,
              },
              views: { views: raw.views.map(toViewRequest), default: raw.defaultViewId },
              publishInteractiveFormViewId: null,
            }),
            { signal, forceRefresh: true },
          );
          result = { id: created.item.id };
          if (raw.nodeId) containerNodes.add(raw.nodeId);
        } else {
          const input: CreateItemRequestContract = {
            type: 'note',
            title: raw.title,
            parentId: resolvedParent,
            properties: raw.properties,
          };
          const created = await ports.core.execute(
            items.createItem(workspaceId, {
              type: input.type,
              title: input.title,
              parentId: input.parentId,
              ...(input.properties !== null ? { properties: input.properties } : {}),
            }),
            { signal, forceRefresh: true },
          );
          result = { id: created.id };
        }
        if (raw.nodeId) {
          nodeItems.set(raw.nodeId, result.id);
          if (raw.nodeId === plan.nodeOrder[0]) rootId = result.id;
          if (raw.nodeId === plan.nodeOrder[0] || containerNodes.has(raw.nodeId))
            links.push(`/w/${workspaceId}?item=${result.id}`);
        }
      } else if (
        raw.kind === 'setRecurrence' ||
        raw.kind === 'setHabit' ||
        raw.kind === 'appendBody'
      ) {
        const targetId =
          'target' in raw && 'nodeId' in raw.target ? nodeItems.get(raw.target.nodeId) : undefined;
        if (targetId === undefined) throw new Error('The blueprint node was not created.');
        if (raw.kind === 'setRecurrence') {
          await ports.core.execute(
            recurrence.setRecurrence(targetId, {
              freq: raw.rule.freq as 'daily' | 'weekly' | 'monthly' | 'yearly',
              interval: raw.rule.interval,
              weekdays:
                raw.rule.weekdays?.map(
                  (day) =>
                    ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'][day - 1] as
                      'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su',
                ) ?? null,
              until: raw.rule.until,
            }),
            { signal, forceRefresh: true },
          );
        } else if (raw.kind === 'setHabit') {
          await ports.core.execute(
            habits.setHabit(targetId, {
              ...raw.settings,
              frequency: raw.settings.frequency as 'daily' | 'weekly',
            }),
            {
              signal,
              forceRefresh: true,
            },
          );
        } else {
          await ports.bodies.append(targetId, raw.markdown, signal);
        }
      } else {
        throw new Error(`Unsupported blueprint step: ${raw.kind}`);
      }
      ledger.push({
        nodeId: rawNodeId(raw),
        step: raw.kind,
        status: 'done',
        ...(result ? { itemId: result.id } : {}),
      });
      completed++;
      onProgress?.(completed, plan.steps.length);
    } catch (error) {
      failedError = error;
      failedNode = rawNodeId(raw);
      rateLimited = isNixApiError(error) && error.status === 429;
      ledger.push({ nodeId: failedNode, step: raw.kind, status: 'failed' });
      for (const remaining of plan.steps.slice(index + 1))
        ledger.push({ nodeId: rawNodeId(remaining), step: remaining.kind, status: 'skipped' });
      break;
    }
  }
  void failedError;
  return {
    rootId,
    complete: ledger.every((entry) => entry.status === 'done'),
    ledger,
    links,
    instruction: ledger.every((entry) => entry.status === 'done')
      ? COMPLETE
      : rateLimited
        ? RATE_LIMITED
        : INCOMPLETE,
    ...(rateLimited ? { rateLimited: true } : {}),
  };
}

function rawNodeId(step: Step): string {
  if ('nodeId' in step && step.nodeId) return step.nodeId;
  if ('target' in step && 'nodeId' in step.target) return step.target.nodeId;
  return '$sandbox';
}
