import {
  compileFields,
  compileView,
  mergeProperties,
  type Blueprint,
  type Node,
  type Step,
  type StructureProperty,
} from '@nix/structure-spec';
import type { CompanionClock } from '../ports.js';

export interface BuildPlan {
  steps: Step[];
  writes: number;
  nodeOrder: string[];
}

export interface PlanBuildOptions {
  parentId: string | null;
  sandboxExists: boolean;
  clock: CompanionClock;
  /** Effective fields at the selected destination; empty for the default Pet drafts sandbox. */
  inheritedFields?: readonly StructureProperty[];
}

/** Compiles a blueprint into a deterministic, depth-first sequence of bounded writes. */
export function planBuild(bp: Blueprint, options: PlanBuildOptions): BuildPlan {
  const steps: Step[] = [];
  const nodeOrder: string[] = [];
  const nodes: Node[] = [];

  if (options.parentId === null && !options.sandboxExists) {
    steps.push({ kind: 'ensureSandbox' });
  }

  function collect(node: Node, parentNodeId?: string): void {
    nodes.push(node);
    nodeOrder.push(node.id);

    const inherited =
      node.inherit === false
        ? []
        : parentNodeId === undefined
          ? (options.inheritedFields ?? [])
          : (effectiveByNode.get(parentNodeId) ?? []);
    const compiledFields = compileFields(node.fields ?? [], { existing: inherited });
    const effective = mergeProperties(inherited, compiledFields.properties);
    effectiveByNode.set(node.id, effective);

    const parentFields: { parentNodeId?: string; sandboxParent?: true } =
      parentNodeId !== undefined
        ? { parentNodeId }
        : options.parentId === null
          ? { sandboxParent: true }
          : {};

    if (node.views !== undefined && node.views.length > 0) {
      const usedIds = new Set<string>();
      const addedKeys = new Set(compiledFields.properties.map((property) => property.key));
      const views = node.views.map((view) => compileView(view, effective, usedIds, addedKeys));
      const defaultIndex = node.views.findIndex((view) => view.default === true);
      const defaultView = views[defaultIndex >= 0 ? defaultIndex : 0];
      if (defaultView === undefined) throw new Error('A container node must have a view.');

      steps.push({
        kind: 'createStructuredItem',
        parentId: parentNodeId === undefined ? options.parentId : null,
        ...parentFields,
        title:
          node.id === bp.root.id
            ? bp.title
            : node.sample === true
              ? `Sample: ${node.title}`
              : node.title,
        schema: { properties: compiledFields.properties, inherit: node.inherit ?? true },
        views,
        defaultViewId: defaultView.id,
        nodeId: node.id,
        ...(node.sample === true ? { sample: true } : {}),
      });
    } else {
      const title = node.sample === true ? `Sample: ${node.title}` : node.title;
      steps.push({
        kind: 'createItem',
        parentId: parentNodeId === undefined ? options.parentId : null,
        ...parentFields,
        title: node.id === bp.root.id ? bp.title : title,
        properties: node.values ?? null,
        nodeId: node.id,
        ...(node.sample === true ? { sample: true } : {}),
      });
    }

    for (const child of node.children ?? []) collect(child, node.id);
  }

  const effectiveByNode = new Map<string, readonly StructureProperty[]>();
  collect(bp.root);

  for (const node of nodes) {
    if (node.recurrence !== undefined) {
      steps.push({
        kind: 'setRecurrence',
        target: { nodeId: node.id },
        rule: {
          freq: node.recurrence.frequency,
          interval: node.recurrence.interval,
          weekdays:
            node.recurrence.frequency === 'weekly' ? (node.recurrence.weekdays ?? []) : null,
          until: node.recurrence.until ?? null,
        },
      });
    }
    if (node.habit !== undefined) {
      steps.push({
        kind: 'setHabit',
        target: { nodeId: node.id },
        settings: {
          frequency: node.habit.frequency,
          weekdays: node.habit.frequency === 'weekly' ? (node.habit.weekdays ?? []) : null,
          startDate: options.clock.today(),
          timezone: options.clock.timeZone(),
          target: node.habit.target,
          unit: node.habit.unit,
        },
      });
    }
  }

  for (const node of nodes) {
    if (node.markdown !== undefined && node.markdown.length > 0) {
      steps.push({ kind: 'appendBody', target: { nodeId: node.id }, markdown: node.markdown });
    }
  }

  const writes = steps.length;
  if (writes > 80) throw new Error('The plan exceeds the write budget.');
  return { steps, writes, nodeOrder };
}
