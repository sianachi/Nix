import { keyFor } from '../spec/keys.js';
import { propertyTypeWord } from '../vocabulary/property-types.js';
import type { Problem, ValidationReport } from '../validate/report.js';
import type { Blueprint, Node } from '../blueprint/schema.js';
import type { PreviewModel, PreviewNode } from './model.js';

export interface DescribeBlueprintContext {
  destination: { title: string; path: string[] };
}

/** Turns a validated blueprint into the plain text tree shown on its approval card. */
export function describeBlueprint(
  blueprint: Blueprint,
  report: ValidationReport,
  context: DescribeBlueprintContext,
): PreviewModel {
  let items = 0;
  let fields = 0;
  let views = 0;
  let entries = 0;
  let writes = context.destination.title === 'Pet drafts' ? 1 : 0;

  function describeNode(node: Node): PreviewNode {
    items += 1;
    fields += node.fields?.length ?? 0;
    views += node.views?.length ?? 0;
    if (node.sample === true) entries += 1;
    writes += 1 + (node.markdown ? 1 : 0) + (node.recurrence ? 1 : 0) + (node.habit ? 1 : 0);

    const detail = (node.fields ?? []).map(
      (field) => `${field.label} (${propertyTypeWord(field.type)})`,
    );
    for (const view of node.views ?? []) {
      const viewName = view.name ?? titleCase(view.kind.replaceAll('_', ' '));
      const group =
        view.groupBy !== undefined ? ` grouped by ${fieldLabel(node, view.groupBy)}` : '';
      detail.push(`${viewName}${group}`);
    }
    if (node.markdown) detail.push('Includes note content');
    if (node.recurrence) detail.push(`Repeats ${node.recurrence.frequency}`);
    if (node.habit) detail.push(`Habit tracker: ${node.habit.frequency}`);

    const label = node.sample === true ? `Example: ${node.title}` : node.title;
    return {
      label,
      detail,
      ...(node.why === undefined ? {} : { why: node.why }),
      children: (node.children ?? []).map(describeNode),
    };
  }

  const tree = describeNode(blueprint.root);
  const summary: PreviewNode = {
    label: blueprint.summary || blueprint.title,
    detail: [],
    children: [],
  };
  const parentDestination = context.destination.title;
  const destinationLabel = parentDestination || 'Pet drafts';
  const headline =
    `I will build ${blueprint.title} in ${destinationLabel}: ` +
    `${count(items, 'item')}, ${count(fields, 'field')}, ${count(views, 'view')} and ` +
    `${count(entries, 'example')}.`;
  const note =
    context.destination.path.length === 0
      ? 'Creates a draft in Pet drafts. Nothing is published.'
      : `Creates a draft in ${parentDestination}. Nothing is published.`;
  const problems: Problem[] = report.problems;

  return {
    headline,
    destination: context.destination,
    counts: { items, fields, views, entries, writes },
    tree: [summary, tree],
    notes: [note],
    warnings: report.warnings,
    problems,
    neverDoes: [],
  };
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function count(value: number, label: string): string {
  return `${String(value)} ${label}${value === 1 ? '' : 's'}`;
}

function fieldLabel(node: Node, ref: string): string {
  return (
    node.fields?.find((field) => field.label.toLowerCase() === ref.toLowerCase())?.label ??
    node.fields?.find((field) => keyFor(field) === ref)?.label ??
    ref
  );
}
