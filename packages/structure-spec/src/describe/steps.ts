import type { Step } from '../compile/steps.js';
import { isWriteStep } from '../compile/steps.js';
import type { StructureForm, StructureProperty, StructureView } from '../types.js';
import { propertyTypeWord } from '../vocabulary/property-types.js';
import type { Problem } from '../validate/report.js';
import type { PreviewModel, PreviewNode } from './model.js';
import { describeAddFields, describeEditForm, describeRecurrence } from './edits.js';

/**
 * What a `Step[]` is described against: where the plan lands, the schema and views already there
 * (an additive operation reads them to say what a new field or view adds on top of), and the
 * problems and warnings a caller already collected (typically `validateSpec`'s report) so a single
 * `PreviewModel` carries both the compiled plan and why it may not be safe to run.
 */
export interface DescribeContext {
  destination: { title: string; path: string[] };
  existing?: {
    declared: readonly StructureProperty[];
    effective: readonly StructureProperty[];
    views: readonly StructureView[];
  };
  problems: Problem[];
  warnings: Problem[];
}

function lookupLabel(key: string, properties: readonly StructureProperty[]): string {
  return properties.find((property) => property.key === key)?.label ?? key;
}

/** "Status (To read, Reading, Done)" for a select with options, "Rating (number)" otherwise. */
function fieldDescriptor(property: StructureProperty): string {
  if (
    (property.type === 'select' || property.type === 'multi_select') &&
    property.options.length > 0
  ) {
    return `${property.label} (${property.options.join(', ')})`;
  }
  return `${property.label} (${propertyTypeWord(property.type)})`;
}

/** "a" -> "a"; "a", "b" -> "a and b"; "a", "b", "c" -> "a, b and c" (no Oxford comma, matching the copy used elsewhere in the pet surface). */
function formatList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0] ?? ''} and ${items[1] ?? ''}`;
  const last = items[items.length - 1] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${last}`;
}

const VIEW_KIND_WORDS: Record<string, string> = {
  list: 'list',
  board: 'board',
  calendar: 'calendar',
  timeline: 'timeline',
  gallery: 'gallery',
  sheet: 'sheet',
  form: 'form',
  interactive_form: 'form',
  query: 'list',
  chart: 'chart',
  habit_tracker: 'habit tracker',
};

function viewKindWord(kind: string): string {
  return VIEW_KIND_WORDS[kind] ?? kind;
}

function viewKindLabel(kind: string): string {
  const word = viewKindWord(kind);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function fieldBlockLabels(form: StructureForm, properties: readonly StructureProperty[]): string[] {
  const labels: string[] = [];
  for (const page of form.pages) {
    for (const block of page.blocks) {
      if (block.kind === 'field' && block.propertyKey !== null) {
        labels.push(lookupLabel(block.propertyKey, properties));
      }
    }
  }
  return labels;
}

function describeView(
  view: StructureView,
  properties: readonly StructureProperty[],
  defaultViewId: string | undefined,
): PreviewNode {
  const detail: string[] = [];
  if (view.groupBy !== null) {
    detail.push(`Grouped by ${lookupLabel(view.groupBy, properties)}`);
  }
  if (
    view.kind === 'interactive_form' &&
    view.interactiveForm !== null &&
    view.interactiveForm !== undefined
  ) {
    const labels = fieldBlockLabels(view.interactiveForm, properties);
    if (labels.length > 0) {
      detail.push(`Asks for ${formatList(labels)}`);
    }
  }
  return {
    label: `${viewKindLabel(view.kind)} view${view.id === defaultViewId ? ' (default)' : ''}`,
    detail,
    children: [],
  };
}

function truncateText(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function describePropertiesRecord(
  properties: Record<string, unknown> | null,
  orderedFields: readonly StructureProperty[] = [],
): string[] {
  if (properties === null) return [];
  const remaining = new Set(Object.keys(properties));
  const details: string[] = [];
  for (const field of orderedFields) {
    const key = Object.hasOwn(properties, field.key)
      ? field.key
      : Object.keys(properties).find(
          (candidate) => candidate.toLowerCase() === field.label.toLowerCase(),
        );
    if (key !== undefined) {
      details.push(`${field.label}: ${formatValue(properties[key])}`);
      remaining.delete(key);
    }
  }
  for (const key of remaining) {
    details.push(`${key}: ${formatValue(properties[key])}`);
  }
  return details;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry)).join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return JSON.stringify(value);
}

/**
 * Describes one `Step` on its own, with no knowledge of the plan it came from. Every `STEP_KINDS`
 * entry has a case here - `describe.test.ts` asserts that directly - and the switch has no default,
 * so a `Step` variant added later and forgotten here fails to typecheck rather than silently
 * falling through to nothing.
 */
export function describeStep(step: Step, context: DescribeContext): PreviewNode {
  switch (step.kind) {
    case 'createStructuredItem': {
      return {
        label: step.title,
        detail: step.schema.properties.map(fieldDescriptor),
        children: step.views.map((view) =>
          describeView(view, step.schema.properties, step.defaultViewId),
        ),
      };
    }
    case 'appendViewSetup': {
      const properties = [...step.properties, ...(context.existing?.effective ?? [])];
      return {
        label: 'Add fields and views',
        detail: step.properties.map(fieldDescriptor),
        children: step.views.map((view) => describeView(view, properties, undefined)),
      };
    }
    case 'replaceViewSetup': {
      return {
        label: `Replace the ${step.viewId} view`,
        detail: step.schema.properties.map(fieldDescriptor),
        children: step.views.map((view) => describeView(view, step.schema.properties, undefined)),
      };
    }
    case 'createItem': {
      return {
        label: step.title,
        detail: describePropertiesRecord(step.properties),
        children: [],
      };
    }
    case 'appendBody': {
      return { label: 'Note content', detail: [truncateText(step.markdown)], children: [] };
    }
    case 'setRecurrence': {
      return {
        label: 'Recurrence',
        detail: [`${step.rule.freq}, every ${String(step.rule.interval)}`],
        children: [],
      };
    }
    case 'setHabit': {
      return {
        label: 'Habit tracking',
        detail: [
          `${step.settings.frequency}, target ${String(step.settings.target)} ${step.settings.unit}`,
        ],
        children: [],
      };
    }
    case 'ensureSandbox': {
      return {
        label: 'Pet drafts',
        detail: ['Creates the sandbox folder if it does not exist yet.'],
        children: [],
      };
    }
    case 'captureTemplate': {
      return { label: 'Capture template', detail: [], children: [] };
    }
    case 'applyTemplate': {
      return { label: 'Apply template', detail: [], children: [] };
    }
  }
}

function countSteps(steps: readonly Step[]): PreviewModel['counts'] {
  let items = 0;
  let fields = 0;
  let views = 0;
  let entries = 0;
  for (const step of steps) {
    switch (step.kind) {
      case 'createStructuredItem':
        items += 1;
        fields += step.schema.properties.length;
        views += step.views.length;
        break;
      case 'appendViewSetup':
        fields += step.properties.length;
        views += step.views.length;
        break;
      case 'replaceViewSetup':
        fields += step.schema.properties.length;
        views += step.views.length;
        break;
      case 'createItem':
        items += 1;
        entries += 1;
        break;
      case 'appendBody':
      case 'setRecurrence':
      case 'setHabit':
      case 'ensureSandbox':
      case 'captureTemplate':
      case 'applyTemplate':
        break;
    }
  }
  return { items, fields, views, entries, writes: steps.filter(isWriteStep).length };
}

type CreateStructuredStep = Extract<Step, { kind: 'createStructuredItem' }>;
type AppendViewSetupStep = Extract<Step, { kind: 'appendViewSetup' }>;
type CreateItemStep = Extract<Step, { kind: 'createItem' }>;

function describeCreateStructured(
  step: CreateStructuredStep,
  context: DescribeContext,
): PreviewModel {
  const properties = step.schema.properties;
  const defaultView = step.views.find((view) => view.id === step.defaultViewId) ?? step.views[0];
  const noun = defaultView !== undefined ? viewKindWord(defaultView.kind) : 'item';
  const destinationPhrase =
    step.parentId === null
      ? 'at the top level of this workspace'
      : `inside ${context.destination.title}`;
  const fieldsClause =
    properties.length > 0 ? ` with ${properties.map(fieldDescriptor).join(', ')}` : '';
  const allFields = [...properties, ...(context.existing?.effective ?? [])];
  const viewClause =
    defaultView !== undefined
      ? ` and a ${viewKindLabel(defaultView.kind)} view${
          defaultView.groupBy !== null
            ? ` grouped by ${lookupLabel(defaultView.groupBy, allFields)}`
            : ''
        }`
      : '';
  const headline = `I will create the ${noun} ${step.title} ${destinationPhrase}${fieldsClause}${viewClause}.`;

  const node: PreviewNode = {
    label: step.title,
    detail: properties.map(fieldDescriptor),
    children: step.views.map((view) => describeView(view, allFields, step.defaultViewId)),
  };

  return {
    headline,
    destination: context.destination,
    counts: countSteps([step]),
    tree: [node],
    notes: [],
    warnings: context.warnings,
    problems: context.problems,
    neverDoes: [],
  };
}

function describeAppendView(step: AppendViewSetupStep, context: DescribeContext): PreviewModel {
  const view = step.views[0];
  const allFields = [...step.properties, ...(context.existing?.effective ?? [])];
  const viewLabel = view !== undefined ? viewKindLabel(view.kind) : 'new';
  let headline = `I will add a ${viewLabel} view to ${context.destination.title}.`;
  if (
    view?.kind === 'interactive_form' &&
    view.interactiveForm !== null &&
    view.interactiveForm !== undefined
  ) {
    const labels = fieldBlockLabels(view.interactiveForm, allFields);
    if (labels.length > 0) {
      headline += ` It asks for ${formatList(labels)}.`;
    }
  }
  headline += ' Existing fields and the note body stay unchanged.';

  const node: PreviewNode = {
    label: context.destination.title,
    detail: step.properties.map(fieldDescriptor),
    children: step.views.map((v) => describeView(v, allFields, undefined)),
  };

  return {
    headline,
    destination: context.destination,
    counts: countSteps([step]),
    tree: [node],
    notes: [],
    warnings: context.warnings,
    problems: context.problems,
    neverDoes: [],
  };
}

function buildEntryNodes(
  steps: readonly Step[],
  orderedFields: readonly StructureProperty[],
): PreviewNode[] {
  const nodes = new Map<string, PreviewNode>();
  const order: string[] = [];
  for (const step of steps) {
    if (step.kind === 'createItem') {
      const key = step.nodeId ?? step.title;
      nodes.set(key, {
        label: step.title,
        detail: describePropertiesRecord(step.properties, orderedFields),
        children: [],
      });
      order.push(key);
    } else if (step.kind === 'appendBody' && 'nodeId' in step.target) {
      const node = nodes.get(step.target.nodeId);
      node?.detail.push(truncateText(step.markdown));
    }
  }
  return order.flatMap((key) => {
    const node = nodes.get(key);
    return node !== undefined ? [node] : [];
  });
}

function describeEntries(steps: readonly Step[], context: DescribeContext): PreviewModel {
  const entrySteps = steps.filter((step): step is CreateItemStep => step.kind === 'createItem');
  const count = entrySteps.length;
  const noun = count === 1 ? 'entry' : 'entries';
  const location =
    context.destination.title.length > 0
      ? `to ${context.destination.title}`
      : 'at the top level of this workspace';
  const headline = `I will add ${String(count)} ${noun} ${location}.`;

  return {
    headline,
    destination: context.destination,
    counts: countSteps(steps),
    tree: buildEntryNodes(steps, context.existing?.effective ?? []),
    notes: [],
    warnings: context.warnings,
    problems: context.problems,
    neverDoes: [],
  };
}

function describeGeneric(steps: readonly Step[], context: DescribeContext): PreviewModel {
  const count = steps.length;
  const target =
    context.destination.title.length > 0 ? context.destination.title : 'this workspace';
  const headline = `I will make ${String(count)} ${count === 1 ? 'change' : 'changes'} to ${target}.`;
  return {
    headline,
    destination: context.destination,
    counts: countSteps(steps),
    tree: steps.map((step) => describeStep(step, context)),
    notes: [],
    warnings: context.warnings,
    problems: context.problems,
    neverDoes: [],
  };
}

/**
 * Describes a compiled `Step[]` as one `PreviewModel` (architecture section 7). The three Phase A
 * operations each get their own headline shape (`create_structured`, `add_view`, `create_entries`,
 * matched here by the shape of the plan rather than a passed-in operation name, since the compiler
 * is the only thing that knows which operation produced a given `Step[]`); anything else - later
 * phases' plans and multi-kind plans such as a blueprint build - falls back to a generic per-step
 * description built from `describeStep`.
 */
export function describeSteps(steps: readonly Step[], context: DescribeContext): PreviewModel {
  if (steps.length === 0) {
    return {
      headline: 'There is nothing to do.',
      destination: context.destination,
      counts: { items: 0, fields: 0, views: 0, entries: 0, writes: 0 },
      tree: [],
      notes: [],
      warnings: context.warnings,
      problems: context.problems,
      neverDoes: [],
    };
  }

  const single = steps.length === 1 ? (steps[0] ?? null) : null;
  if (single !== null && single.kind === 'createStructuredItem') {
    return describeCreateStructured(single, context);
  }
  if (single !== null && single.kind === 'appendViewSetup') {
    return single.views.length === 0
      ? describeAddFields(single, context)
      : describeAppendView(single, context);
  }
  if (single !== null && single.kind === 'replaceViewSetup') {
    return describeEditForm(single, context);
  }
  if (single !== null && single.kind === 'setRecurrence') {
    return describeRecurrence(single, context);
  }
  if (steps.every((step) => step.kind === 'createItem' || step.kind === 'appendBody')) {
    return describeEntries(steps, context);
  }
  return describeGeneric(steps, context);
}
