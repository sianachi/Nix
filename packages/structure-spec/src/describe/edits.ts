import type { Step } from '../compile/steps.js';
import type {
  StructureForm,
  StructureFormBlock,
  StructureProperty,
  StructureView,
} from '../types.js';
import type { DescribeContext } from './steps.js';
import type { PreviewModel, PreviewNode } from './model.js';

type AppendFieldsStep = Extract<Step, { kind: 'appendViewSetup' }>;
type ReplaceFormStep = Extract<Step, { kind: 'replaceViewSetup' }>;
type RecurrenceStep = Extract<Step, { kind: 'setRecurrence' }>;

function typeWord(type: string): string {
  const labels: Record<string, string> = {
    text: 'text',
    number: 'number',
    select: 'select',
    multi_select: 'multi-select',
    date: 'date',
    timestamp: 'date and time',
    checkbox: 'checkbox',
    url: 'link',
    image: 'picture',
    due_date: 'due date',
    start_date: 'start date',
    completion: 'completion',
    priority: 'priority',
    estimate: 'estimate',
    formula: 'formula',
    rollup: 'rollup',
  };
  return labels[type] ?? type;
}

function fieldLabel(property: StructureProperty): string {
  if (
    (property.type === 'select' || property.type === 'multi_select') &&
    property.options.length > 0
  ) {
    return `${property.label} (${property.options.join(', ')})`;
  }
  return `${property.label} (${typeWord(property.type)})`;
}

function list(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? '';
  const first = values[0] ?? '';
  const second = values[1] ?? '';
  if (values.length === 2) return `${first} and ${second}`;
  const last = values.at(-1) ?? '';
  return `${values.slice(0, -1).join(', ')} and ${last}`;
}

function baseModel(
  context: DescribeContext,
  counts: PreviewModel['counts'],
  headline: string,
  tree: PreviewNode[],
): PreviewModel {
  return {
    headline,
    destination: context.destination,
    counts,
    tree,
    notes: [],
    warnings: context.warnings,
    problems: context.problems,
    neverDoes: [],
  };
}

export function describeAddFields(step: AppendFieldsStep, context: DescribeContext): PreviewModel {
  const descriptors = step.properties.map(fieldLabel);
  const fieldsWord = step.properties.length === 1 ? 'field' : 'fields';
  return baseModel(
    context,
    { items: 0, fields: step.properties.length, views: 0, entries: 0, writes: 1 },
    `I will add ${String(step.properties.length)} ${fieldsWord} to ${context.destination.title}: ${descriptors.join(', ')}. No field is removed or changed.`,
    [
      {
        label: context.destination.title,
        detail: descriptors,
        children: [],
      },
    ],
  );
}

function viewById(
  views: readonly StructureView[] | undefined,
  id: string,
): StructureView | undefined {
  return views?.find((view) => view.id === id);
}

function blockIdentity(block: StructureFormBlock): string {
  if (block.kind === 'field') return `field:${block.propertyKey ?? block.id}`;
  return `${block.kind}:${block.id}`;
}

function conditionText(blockIds: ReadonlyMap<string, string>, block: StructureFormBlock): string[] {
  return block.visibleWhen.map((condition) => {
    const label = blockIds.get(condition.fieldBlockId) ?? condition.fieldBlockId;
    const operator: Record<string, string> = {
      equals: 'equals',
      not_equals: 'does not equal',
      contains: 'contains',
      checked: 'is checked',
      not_checked: 'is not checked',
    };
    const op = operator[condition.operator] ?? condition.operator;
    return condition.value === null ? `${label} ${op}` : `${label} ${op} ${condition.value}`;
  });
}

function formBlockLabels(form: StructureForm): Map<string, string> {
  const labels = new Map<string, string>();
  for (const page of form.pages) {
    for (const block of page.blocks) {
      labels.set(block.id, block.text);
    }
  }
  return labels;
}

function pageConditions(
  labels: ReadonlyMap<string, string>,
  conditions: StructureForm['pages'][number]['visibleWhen'],
): string[] {
  const operator: Record<string, string> = {
    equals: 'equals',
    not_equals: 'does not equal',
    contains: 'contains',
    checked: 'is checked',
    not_checked: 'is not checked',
  };
  return conditions.map((condition) => {
    const label = labels.get(condition.fieldBlockId) ?? condition.fieldBlockId;
    const op = operator[condition.operator] ?? condition.operator;
    return condition.value === null ? `${label} ${op}` : `${label} ${op} ${condition.value}`;
  });
}

function diffConditions(before: readonly string[], after: readonly string[]): string | undefined {
  if (before.join('\u0000') === after.join('\u0000')) return undefined;
  if (after.length === 0) return 'No longer shown conditionally.';
  return `Now shown when ${list(after)}.`;
}

function describeBlockChanges(
  oldForm: StructureForm | undefined,
  newForm: StructureForm,
  oldBlocks: readonly StructureFormBlock[] = oldForm?.pages.flatMap((page) => page.blocks) ?? [],
  newBlocks: readonly StructureFormBlock[] = newForm.pages.flatMap((page) => page.blocks),
): string[] {
  const oldPages = oldForm?.pages ?? [];
  const oldLabels = formBlockLabels(oldForm ?? { ...newForm, pages: oldPages });
  const newLabels = formBlockLabels(newForm);
  const details: string[] = [];

  const oldByIdentity = new Map(oldBlocks.map((block) => [blockIdentity(block), block] as const));
  const newByIdentity = new Map(newBlocks.map((block) => [blockIdentity(block), block] as const));

  for (const [identity, block] of newByIdentity) {
    const prior = oldByIdentity.get(identity);
    if (prior === undefined) {
      details.push(
        block.kind === 'field'
          ? `Added question: ${block.text}`
          : `Added ${block.kind}: ${block.text}`,
      );
      const conditions = block.kind === 'field' ? conditionText(newLabels, block) : [];
      const conditionChange = diffConditions([], conditions);
      if (conditionChange !== undefined) details.push(conditionChange);
      continue;
    }

    if (block.text !== prior.text || block.help !== prior.help) {
      details.push(
        block.kind === 'field'
          ? `Reworded question: ${block.text}`
          : `Reworded ${block.kind}: ${block.text}`,
      );
    }
    if (block.kind === 'field' && prior.kind === 'field') {
      if (block.help !== prior.help) details.push(`Updated help for question: ${block.text}`);
      if (block.required !== prior.required) {
        details.push(
          `${block.required ? 'Marked' : 'No longer requires'} question ${block.text}${block.required ? ' as required.' : '.'}`,
        );
      }
      if (block.identityRole !== prior.identityRole) {
        details.push(`Updated identity role for question: ${block.text}`);
      }
    }

    if (block.kind === 'field' && prior.kind === 'field') {
      const conditionChange = diffConditions(
        conditionText(oldLabels, prior),
        conditionText(newLabels, block),
      );
      if (conditionChange !== undefined) details.push(conditionChange);
    }
  }

  for (const [identity, block] of oldByIdentity) {
    if (newByIdentity.has(identity)) continue;
    details.push(
      block.kind === 'field'
        ? `Removed question: ${block.text}`
        : `Removed ${block.kind}: ${block.text}`,
    );
  }

  // Form title and confirmation copy are user-visible too; include their changes in the same
  // approval diff instead of leaving an edit invisible when no page block changed.
  if (oldForm !== undefined) {
    if (
      oldForm.titleMode !== newForm.titleMode ||
      titleFieldKey(oldForm) !== titleFieldKey(newForm)
    ) {
      details.push('Updated the response title rule.');
    }
    if (
      oldForm.confirmationTitle !== newForm.confirmationTitle ||
      oldForm.confirmationMessage !== newForm.confirmationMessage
    ) {
      details.push('Updated the confirmation message.');
    }
  }

  return details;
}

function titleFieldKey(form: StructureForm): string | null {
  if (form.titleMode !== 'field' || form.titleFieldBlockId === null) return null;
  for (const page of form.pages) {
    const block = page.blocks.find((candidate) => candidate.id === form.titleFieldBlockId);
    if (block !== undefined) return block.propertyKey;
  }
  return null;
}

function describePageChanges(
  oldForm: StructureForm | undefined,
  newForm: StructureForm,
): PreviewNode[] {
  const oldPages = oldForm?.pages ?? [];
  const oldById = new Map(oldPages.map((page) => [page.id, page]));
  const newById = new Map(newForm.pages.map((page) => [page.id, page]));
  const nodes: PreviewNode[] = [];

  newForm.pages.forEach((page, index) => {
    const oldPage = oldById.get(page.id);
    const details: string[] = [];
    if (oldPage === undefined) details.push('Page added.');
    else if (oldPage.title !== page.title) details.push(`Renamed from ${oldPage.title}.`);
    if (oldPage?.description !== page.description && oldPage !== undefined) {
      details.push('Updated the page description.');
    }
    const pageConditionChange =
      oldPage === undefined
        ? diffConditions([], pageConditions(formBlockLabels(newForm), page.visibleWhen))
        : diffConditions(
            pageConditions(formBlockLabels(oldForm ?? newForm), oldPage.visibleWhen),
            pageConditions(formBlockLabels(newForm), page.visibleWhen),
          );
    if (pageConditionChange !== undefined) details.push(pageConditionChange);

    const oldPageBlocks = oldPage?.blocks ?? [];
    details.push(...describeBlockChanges(oldForm, newForm, oldPageBlocks, page.blocks));
    nodes.push({
      label: `Page ${String(index + 1)}: ${page.title}`,
      detail: details,
      children: [],
    });
  });

  oldPages.forEach((page, index) => {
    if (newById.has(page.id)) return;
    if (oldForm === undefined) return;
    nodes.push({
      label: `Page ${String(index + 1)}: ${page.title}`,
      detail: [
        'Page removed.',
        ...describeBlockChanges(oldForm, { ...oldForm, pages: [] }, page.blocks, []),
      ],
      children: [],
    });
  });
  return nodes;
}

export function describeEditForm(step: ReplaceFormStep, context: DescribeContext): PreviewModel {
  const oldView = viewById(context.existing?.views, step.viewId);
  const newView = viewById(step.views, step.viewId);
  const oldForm = oldView?.interactiveForm ?? undefined;
  const newForm = newView?.interactiveForm ?? undefined;
  const newFields = step.schema.properties.map(fieldLabel);
  const tree: PreviewNode[] = newForm === undefined ? [] : describePageChanges(oldForm, newForm);

  if (newFields.length > 0 && tree.length > 0) {
    tree[0]?.detail.unshift(...newFields.map((field) => `Added field: ${field}`));
  } else if (newFields.length > 0) {
    tree.push({
      label: 'New fields',
      detail: newFields.map((field) => `Added field: ${field}`),
      children: [],
    });
  }

  return baseModel(
    context,
    { items: 0, fields: step.schema.properties.length, views: 1, entries: 0, writes: 1 },
    `I will update the interactive form on ${context.destination.title}.`,
    tree,
  );
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function describeRecurrence(step: RecurrenceStep, context: DescribeContext): PreviewModel {
  const unitByFrequency: Record<string, string> = {
    daily: 'day',
    weekly: 'week',
    monthly: 'month',
    yearly: 'year',
  };
  const unit = unitByFrequency[step.rule.freq] ?? step.rule.freq;
  let cadence = `every ${String(step.rule.interval)} ${unit}${step.rule.interval === 1 ? '' : 's'}`;
  if (step.rule.freq === 'weekly' && step.rule.weekdays !== null && step.rule.weekdays.length > 0) {
    const days = step.rule.weekdays.flatMap((day) => {
      const name = WEEKDAYS[day - 1];
      return name === undefined ? [] : [name];
    });
    cadence += ` on ${list(days)}`;
  }
  if (step.rule.until !== null) cadence += ` until ${step.rule.until}`;
  return baseModel(
    context,
    { items: 0, fields: 0, views: 0, entries: 0, writes: 1 },
    `I will make the linked item repeat ${cadence}.`,
    [{ label: 'Recurrence', detail: [cadence], children: [] }],
  );
}
