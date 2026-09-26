import { SMART_LISTS } from '../vocabulary/smart-lists.js';
import { keyFor } from '../spec/keys.js';
import type { StructureProperty } from '../types.js';
import type { Problem } from '../validate/report.js';
import type { Blueprint, Node } from './schema.js';

/** Collects the six non-blocking design hints in architecture section 4. */
export function collectWarnings(
  blueprint: Blueprint,
  effective: ReadonlyMap<string, readonly StructureProperty[]>,
): Problem[] {
  const warnings: Problem[] = [];

  function visit(node: Node, path: string): void {
    const children = node.children ?? [];
    const childContainers = children.filter((child) => (child.views?.length ?? 0) > 0);
    const sets = childContainers.map((child) => ({
      child,
      keys: (effective.get(child.id) ?? []).map((field) => field.key).sort(),
    }));
    const matchingPair = sets.find((entry, index) =>
      sets.slice(index + 1).some((other) => same(entry.keys, other.keys)),
    );
    if (matchingPair !== undefined) {
      warnings.push({
        path: `${path}.children`,
        code: 'warn.sibling_containers_same_fields',
        message:
          'These sibling containers have the same fields; consider one container with two views.',
      });
    }

    const ownKeys = new Set((node.fields ?? []).map(keyFor));
    if (children.length > 1) {
      const repeated = (children[0]?.fields ?? []).map(keyFor);
      if (
        repeated.length > 0 &&
        children.every((child) => {
          const keys = new Set((child.fields ?? []).map(keyFor));
          return repeated.every((key) => keys.has(key));
        }) &&
        repeated.some((key) => !ownKeys.has(key))
      ) {
        warnings.push({
          path: `${path}.children`,
          code: 'warn.fields_repeated_on_children',
          message:
            'The same fields are declared on every child; consider declaring them once on the parent.',
        });
      }
    }

    const effectiveFields = effective.get(node.id) ?? [];
    for (const [index, field] of (node.fields ?? []).entries()) {
      if (field.type !== 'number') continue;
      const childHasNumber = children.some((child) =>
        (effective.get(child.id) ?? []).some(
          (candidate) => candidate.key === keyFor(field) && candidate.type === 'number',
        ),
      );
      if (childHasNumber) {
        warnings.push({
          path: `${path}.fields[${String(index)}]`,
          code: 'warn.number_could_be_rollup',
          message: `'${field.label}' is also present as a number on child items; consider a rollup.`,
        });
      }
    }

    if (node.recurrence === undefined && /\b(weekly|daily|monthly|every)\b/i.test(node.title)) {
      warnings.push({
        path: `${path}.title`,
        code: 'warn.repeating_title_without_recurrence',
        message: 'This title sounds repeating; consider adding recurrence.',
      });
    }

    if (node.views?.length === 1 && node.views[0]?.kind === 'list' && effectiveFields.length > 5) {
      warnings.push({
        path: `${path}.views[0]`,
        code: 'warn.list_only_many_fields',
        message:
          'This container has more than five fields and only a list view; consider another view.',
      });
    }

    (node.views ?? []).forEach((view, index) => {
      if (view.kind !== 'query' || view.filters === undefined) return;
      const filters = canonicalFilters(
        view.filters.map((filter) => ({
          property: filter.field,
          operator: filter.op,
          value: filter.value,
        })),
      );
      if (SMART_LISTS.some((preset) => same(filters, canonicalFilters(preset.filters)))) {
        warnings.push({
          path: `${path}.views[${String(index)}]`,
          code: 'warn.query_duplicates_smart_list',
          message: 'These filters match a smart list preset; consider using that preset.',
        });
      }
    });

    children.forEach((child, index) => {
      visit(child, `${path}.children[${String(index)}]`);
    });
  }

  visit(blueprint.root, 'root');
  return warnings;
}

function canonicalFilters(
  filters: readonly { property: string; operator: string; value: string }[],
): string[] {
  return filters.map((filter) => `${filter.property}\0${filter.operator}\0${filter.value}`).sort();
}

function same<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
