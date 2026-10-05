import { PROPERTY_FORMULA_LIMITS } from '@nix/sheet';

import type { StructureProperty, StructureSchema } from '../types.js';
import { isComputedType, valueShapeOf } from '../vocabulary/property-types.js';

/**
 * Every task-semantic type, matching `PropertyType.IsTaskSemantic`
 * (`backend/src/Nix.Api/Domain/Properties/PropertyType.cs:352-354`) - which, unlike
 * `spec/field.ts`'s `TASK_SEMANTIC_FIELD_TYPES`, includes `assignee`. A pet can never declare an
 * `assignee` field (`fieldSpecSchema` excludes the type outright), but `refuseSchema` also runs
 * against inherited and existing properties a human declared, and an inherited assignee keyed
 * anything other than `assignee` is exactly as wrong as an inherited due date keyed anything other
 * than `due_date`.
 */
const TASK_SEMANTIC_TYPES: ReadonlySet<string> = new Set([
  'due_date',
  'start_date',
  'completion',
  'priority',
  'estimate',
  'assignee',
]);
const NUMERIC_AGGREGATES: ReadonlySet<string> = new Set(['sum', 'average', 'min', 'max']);

/** The key `ItemProperties.TitleKey` reserves; every item already carries its own title. */
const TITLE_KEY = 'title';

function findByKey(
  schema: StructureSchema,
  key: string | null | undefined,
): StructureProperty | undefined {
  if (key === null || key === undefined) {
    return undefined;
  }
  return schema.properties.find((property) => property.key === key);
}

function fitsAggregate(aggregate: string, sourceType: string): boolean {
  if (aggregate === 'count') {
    return true;
  }
  const shape = valueShapeOf(sourceType);
  return NUMERIC_AGGREGATES.has(aggregate) ? shape === 'number' : shape === 'checkbox';
}

/**
 * The property keys an expression reads, ported from `FormulaReferences.Read`
 * (`backend/src/Nix.Api/Domain/Properties/FormulaReferences.cs:48-109`) rather than built on
 * `@nix/sheet`'s `planPropertyFormulas`: that function is a real parser, and an expression that
 * does not parse (or that runs over its op budget) is dropped from its dependency graph entirely,
 * so a cycle running *through* an unparseable formula would go undetected. `FormulaReferences.Read`
 * is not a parser - it is the bracket scan this function copies verbatim, string literals (with
 * their doubled-quote escape) skipped exactly as the lexer skips them, everything else about the
 * expression left to whatever reads it later. Copying the scan, rather than reusing the sheet
 * package's real one, is what lets this function agree with Core on every input, parseable or not.
 */
function readFormulaReferences(expression: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let index = 0;

  while (index < expression.length) {
    const character = expression[index];

    if (character === '"') {
      index += 1;
      while (index < expression.length) {
        if (expression[index] === '"') {
          if (index + 1 < expression.length && expression[index + 1] === '"') {
            index += 2;
            continue;
          }
          break;
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    if (character !== '[') {
      index += 1;
      continue;
    }

    const close = expression.indexOf(']', index + 1);
    if (close < 0) {
      break;
    }

    const key = expression.slice(index + 1, close).trim();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      found.push(key);
    }

    index = close + 1;
  }

  return found;
}

/**
 * The ordinal-first key on a cycle, or `null` when the formulas order without one - Kahn's
 * algorithm, ported from `FormulaReferences.FindCycle`
 * (`backend/src/Nix.Api/Domain/Properties/FormulaReferences.cs:135-186`) so the tie-break (the
 * lowest-ordinal key left unsettled, not whichever this happens to visit first) matches exactly.
 */
function findFormulaCycle(formulas: ReadonlyMap<string, string>): string | null {
  if (formulas.size === 0) {
    return null;
  }

  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const key of formulas.keys()) {
    dependents.set(key, []);
    indegree.set(key, 0);
  }

  for (const [key, expression] of formulas) {
    const precedents = new Set<string>();
    for (const reference of readFormulaReferences(expression)) {
      if (formulas.has(reference)) {
        precedents.add(reference);
      }
    }
    for (const precedent of precedents) {
      dependents.get(precedent)?.push(key);
      indegree.set(key, (indegree.get(key) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [key, degree] of indegree) {
    if (degree === 0) {
      queue.push(key);
    }
  }

  let settled = 0;
  let head = 0;
  while (head < queue.length) {
    const key = queue[head];
    head += 1;
    if (key === undefined) {
      break;
    }
    settled += 1;
    for (const dependent of dependents.get(key) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        queue.push(dependent);
      }
    }
  }

  if (settled === formulas.size) {
    return null;
  }

  let first: string | null = null;
  for (const [key, degree] of indegree) {
    if (degree > 0 && (first === null || key < first)) {
      first = key;
    }
  }
  return first;
}

function refuseCycle(schema: StructureSchema): string | null {
  const formulas = new Map<string, string>();
  for (const property of schema.properties) {
    if (
      property.type === 'formula' &&
      property.expression !== null &&
      property.expression !== undefined
    ) {
      formulas.set(property.key, property.expression);
    }
  }

  const key = findFormulaCycle(formulas);
  return key === null
    ? null
    : `'${key}' is a formula that refers back to itself, directly or through another formula.`;
}

/**
 * Ports `PropertySchemaRules.Refuse` (`backend/src/Nix.Api/Domain/Properties/PropertySchemaRules.cs`)
 * so the client can tell a pet its declared schema is unstorable before Core ever sees it. Returns
 * the first reason, exactly as the server does - `rule-parity.json` and `parity.test.ts` pin this
 * copy against the server's, case for case.
 *
 * A blank `expression` or `source` (all whitespace, or empty) is read as absent before any rule
 * runs, matching `PropertyMapping`'s own normalisation
 * (`backend/src/Nix.Api/Features/Properties/PropertyMapping.cs:63-75,110-111`) on the way into a
 * domain `PropertyDefinition`: Core never sees the blank string this function is handed, so
 * treating it as present here would refuse (or fail to refuse) things Core does not.
 */
export function refuseSchema(schema: StructureSchema): string | null {
  const keys = new Set<string>();

  for (const raw of schema.properties) {
    const property = {
      ...raw,
      expression: blankToNull(raw.expression),
      source: blankToNull(raw.source),
    };

    if (property.key.length === 0) {
      return 'Every property needs a key.';
    }

    if (keys.has(property.key)) {
      return `'${property.key}' is declared more than once; a property cannot mean two things.`;
    }
    keys.add(property.key);

    if (TASK_SEMANTIC_TYPES.has(property.type) && property.key !== property.type) {
      return (
        `A ${property.type} property must use the key '${property.type}'; '${property.key}' is a ` +
        'different name for a role the whole workspace has to agree on. Rename the label instead.'
      );
    }

    if (property.key === TITLE_KEY) {
      return "'title' is managed by the item itself and cannot be redeclared.";
    }

    const hasOptions = property.type === 'select' || property.type === 'multi_select';
    if (hasOptions && property.options.length === 0) {
      return `'${property.label}' is a select and needs at least one option.`;
    }
    if (!hasOptions && property.options.length > 0) {
      return `'${property.label}' is not a select, so it cannot carry options.`;
    }

    if (property.type === 'formula') {
      if (property.expression === null) {
        return `'${property.label}' is a formula and needs an expression.`;
      }
      if (property.expression.length > PROPERTY_FORMULA_LIMITS.maxLength) {
        return (
          `'${property.label}' has an expression longer than ` +
          `${String(PROPERTY_FORMULA_LIMITS.maxLength)} characters, which is more than a formula ` +
          'property will evaluate.'
        );
      }
    } else if (property.expression !== null) {
      return `'${property.label}' is not a formula, so it cannot carry an expression.`;
    }

    if (property.type === 'rollup') {
      const aggregate = property.aggregate;
      if (aggregate === null || aggregate === undefined) {
        return `'${property.label}' is a rollup and needs to say how it folds its children.`;
      }

      if (property.source === null && aggregate !== 'count') {
        return (
          `'${property.label}' folds its children with ${aggregate}, which needs a property to fold. ` +
          'Only a count can be taken of the children themselves.'
        );
      }

      if (property.source === property.key) {
        return (
          `'${property.label}' folds a property with its own key, which would fold itself in every ` +
          'item beneath this one. Give the rollup its own key.'
        );
      }

      const folded = findByKey(schema, property.source);
      if (folded !== undefined && !fitsAggregate(aggregate, folded.type)) {
        return (
          `'${property.label}' folds '${folded.label}' with ${aggregate}, which needs ` +
          (NUMERIC_AGGREGATES.has(aggregate) ? 'a number.' : 'a checkbox.')
        );
      }
    } else if (
      (property.aggregate !== null && property.aggregate !== undefined) ||
      property.source !== null
    ) {
      return `'${property.label}' is not a rollup, so it cannot say how to fold children.`;
    }

    if (isComputedType(property.type) && property.required) {
      return (
        `'${property.label}' is computed, so it cannot be required - nothing writes a value for it ` +
        'to be missing.'
      );
    }
  }

  return refuseCycle({
    properties: schema.properties.map((property) => ({
      ...property,
      expression: blankToNull(property.expression),
    })),
    inherit: schema.inherit,
  });
}

function blankToNull(text: string | null | undefined): string | null {
  if (text === null || text === undefined) {
    return null;
  }
  return text.trim().length === 0 ? null : text;
}
