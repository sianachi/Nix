import type { z } from 'zod';

import type {
  StructureFormBlock,
  StructureFormCondition,
  StructureFormPage,
  StructureProperty,
  StructureView,
} from '../types.js';
import type { FieldSpec } from '../spec/field.js';
import { type Cond, type FormSpec } from '../spec/form.js';
import {
  type EntriesSpec,
  applySpecSchema,
  entriesSpecSchema,
  structuredSpecSchema,
  viewSetupSpecSchema,
} from '../spec/operations.js';
import { keyFor } from '../spec/keys.js';
import { type FieldRefResolution, type ResolvedField, resolveFieldRef } from '../spec/refs.js';
import type { ViewSpec } from '../spec/view.js';
import { mergeProperties } from '../vocabulary/merge-properties.js';
import { refuseSchema } from './schema-rules.js';
import { refuseViews } from './view-rules.js';
import { validateValue } from './values.js';
import type { Problem, ValidationContext, ValidationReport } from './report.js';

export type SpecOperation = 'create_structured' | 'add_view' | 'create_entries' | 'apply_template';

/**
 * A `FieldRef` resolution scope: fields already in effect before this operation, matched only by
 * their exact key, and fields this operation is itself declaring, matched by key or - because a
 * pet did choose them - by label too. `spec.ts`'s own field, view and form compilation all resolve
 * refs against one of these per operation, so a rollup source, a `groupBy`, or a form field can
 * each name either an inherited property or a field the same request is adding.
 */
interface RefScope {
  existing: readonly StructureProperty[];
  added: readonly ResolvedField[];
}

function formatPath(path: readonly PropertyKey[]): string {
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${String(segment)}]`;
    } else {
      const text = String(segment);
      result += result.length === 0 ? text : `.${text}`;
    }
  }
  return result;
}

function zodIssuesToProblems(error: z.ZodError): Problem[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    code: issue.code,
    message: issue.message,
  }));
}

function statsFromRaw(raw: unknown): ValidationReport['stats'] {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    fields: Array.isArray(record.fields) ? record.fields.length : 0,
    views: Array.isArray(record.views) ? record.views.length : 0,
    entries: Array.isArray(record.entries) ? record.entries.length : 0,
  };
}

function refFailureMessage(
  ref: string,
  resolution: Extract<FieldRefResolution, { ok: false }>,
): string {
  return resolution.code === 'unknown'
    ? `'${ref}' does not name a field.`
    : `'${ref}' could mean ${resolution.candidates.join(' or ')}; say which.`;
}

/**
 * Resolves one `FieldRef`, pushing a problem when it does not resolve. `undefined` is a ref this
 * operation never supplied, which is not itself a problem - the caller's own presence check (a
 * kind requirement, for example) is where that gets refused.
 */
function resolveRef(
  ref: string | undefined,
  scope: RefScope,
  path: string,
  problems: Problem[],
): string | null {
  if (ref === undefined) {
    return null;
  }
  const resolution = resolveFieldRef(ref, scope);
  if (!resolution.ok) {
    problems.push({ path, code: resolution.code, message: refFailureMessage(ref, resolution) });
    return null;
  }
  return resolution.key;
}

/**
 * The field-to-property half of the compiler `packages/structure-spec/src/compile/*`
 * (`docs/plans/pet-structure-consult-plan.md`, task A.1b) will own once it lands. That compiler
 * and this validator are built in the same wave from the same base, so this module carries its
 * own minimal, validation-only version rather than depending on code that does not exist yet in
 * this worktree - once A.1b merges, this function and `compileViewForValidation` /
 * `compileFormForValidation` below should be replaced with calls into it, not kept alongside it.
 */
function compileFieldSpecs(
  specs: readonly FieldSpec[],
  existing: readonly StructureProperty[],
  path: string,
  problems: Problem[],
): StructureProperty[] {
  const added: ResolvedField[] = specs.map((field) => ({ key: keyFor(field), label: field.label }));

  return specs.map((field, index) => {
    const key = added[index]?.key ?? keyFor(field);
    let source: string | null = null;

    if (field.type === 'rollup' && field.rollup?.source !== undefined) {
      source = resolveRef(
        field.rollup.source,
        { existing, added },
        `${path}[${String(index)}].rollup.source`,
        problems,
      );
    }

    return {
      key,
      label: field.label,
      type: field.type,
      options: field.options ?? [],
      required: field.required ?? false,
      expression: field.type === 'formula' ? (field.formula ?? null) : null,
      aggregate: field.type === 'rollup' ? (field.rollup?.aggregate ?? null) : null,
      source,
    } satisfies StructureProperty;
  });
}

/**
 * Compiles one form spec into enough of a `StructureForm` for `refuseViews` to check - page and
 * block ids, and each condition's `field` resolved to the id of the earlier field block it means -
 * without assigning the ids the real compiler (A.1b) will eventually store. A block only becomes
 * "earlier" for the conditions after it, matching `ViewDefinitionRules.RefuseForm`'s own
 * sequential pass.
 */
function compileFormForValidation(
  form: FormSpec,
  scope: RefScope,
  viewPath: string,
  problems: Problem[],
): {
  pages: StructureFormPage[];
  titleMode: string;
  titleFieldBlockId: string | null;
  confirmationTitle: string;
  confirmationMessage: string;
} {
  const fieldBlockIdByKey = new Map<string, string>();
  let blockCounter = 0;
  let pageCounter = 0;

  function compileConditions(
    conditions: readonly Cond[] | undefined,
    path: string,
  ): StructureFormCondition[] {
    return (conditions ?? []).map((condition) => {
      const key = resolveRef(condition.field, scope, `${path}.showWhen.field`, problems);
      const fieldBlockId = key !== null ? fieldBlockIdByKey.get(key) : undefined;
      return {
        fieldBlockId: fieldBlockId ?? '',
        operator: condition.op,
        value: condition.value ?? null,
      } satisfies StructureFormCondition;
    });
  }

  const pages: StructureFormPage[] = form.pages.map((page) => {
    pageCounter += 1;
    const pageId = `p${String(pageCounter)}`;
    const pageVisibleWhen = compileConditions(page.showWhen, `${viewPath}.form.${pageId}`);

    const blocks: StructureFormBlock[] = page.blocks.map((block) => {
      blockCounter += 1;
      const blockId = `b${String(blockCounter)}`;

      if ('field' in block) {
        const key = resolveRef(block.field, scope, `${viewPath}.form.${blockId}.field`, problems);
        const visibleWhen = compileConditions(block.showWhen, `${viewPath}.form.${blockId}`);
        if (key !== null) {
          fieldBlockIdByKey.set(key, blockId);
        }
        return {
          id: blockId,
          kind: 'field',
          propertyKey: key,
          text: '',
          help: block.help ?? null,
          required: block.required ?? false,
          identityRole: block.identity ?? null,
          visibleWhen,
        } satisfies StructureFormBlock;
      }

      if ('heading' in block) {
        return {
          id: blockId,
          kind: 'heading',
          propertyKey: null,
          text: block.heading,
          help: null,
          required: false,
          identityRole: null,
          visibleWhen: [],
        } satisfies StructureFormBlock;
      }

      return {
        id: blockId,
        kind: 'paragraph',
        propertyKey: null,
        text: block.paragraph,
        help: null,
        required: false,
        identityRole: null,
        visibleWhen: [],
      } satisfies StructureFormBlock;
    });

    return {
      id: pageId,
      title: page.title,
      description: page.description ?? null,
      visibleWhen: pageVisibleWhen,
      blocks,
    } satisfies StructureFormPage;
  });

  const titleMode = form.title?.from ?? 'generated';
  let titleFieldBlockId: string | null = null;
  if (form.title?.from === 'field') {
    const key = resolveRef(form.title.field, scope, `${viewPath}.form.title.field`, problems);
    titleFieldBlockId = key !== null ? (fieldBlockIdByKey.get(key) ?? null) : null;
  }

  return {
    pages,
    titleMode,
    titleFieldBlockId,
    confirmationTitle: form.confirmation?.title ?? '',
    confirmationMessage: form.confirmation?.message ?? '',
  };
}

/** Compiles one view spec into enough of a `StructureView` for `refuseViews` to check. */
function compileViewForValidation(
  view: ViewSpec,
  scope: RefScope,
  index: number,
  problems: Problem[],
): StructureView {
  const path = `views[${String(index)}]`;
  const groupBy = resolveRef(view.groupBy, scope, `${path}.groupBy`, problems);
  const dateProperty = resolveRef(view.date, scope, `${path}.date`, problems);
  const endDateProperty = resolveRef(view.endDate, scope, `${path}.endDate`, problems);
  const coverProperty = resolveRef(view.cover, scope, `${path}.cover`, problems);
  const measureProperty = resolveRef(view.measureField, scope, `${path}.measureField`, problems);
  const sortBy = resolveRef(view.sortBy, scope, `${path}.sortBy`, problems);

  // A filter's property is never resolved against the schema: `FilterRule.cs`'s own comment is
  // that a query view spans containers and a rule naming a property nothing declares simply
  // matches nothing, so this mirrors Core by passing the raw field text through unchanged.
  const filters = (view.filters ?? []).map((filter) => ({
    property: filter.field,
    operator: filter.op,
    value: filter.value,
  }));

  const interactiveForm =
    view.kind === 'interactive_form' && view.form !== undefined
      ? compileFormForValidation(view.form, scope, path, problems)
      : null;

  return {
    id: `view-${String(index)}`,
    name: view.name ?? view.kind,
    kind: view.kind,
    columns: view.columns ?? [],
    groupBy,
    groupOrder: view.groupOrder ?? [],
    dateProperty,
    sortBy,
    sortDescending: view.sortDescending ?? false,
    mode: view.mode ?? null,
    coverProperty,
    endDateProperty,
    cardSize: view.cardSize ?? null,
    layout: null,
    filters,
    measure: view.measure ?? null,
    measureProperty,
    interactiveForm,
  };
}

/**
 * The additive-collision rule `StructuredItemSetup.HandleAsync`
 * (`backend/src/Nix.Api/Features/Views/StructuredItemSetup.cs`, around line 226) applies before
 * `PropertySchemaRules.Refuse` ever runs: an append refuses a key the effective schema already
 * has rather than silently overriding it, because `mergeProperties`'s nearest-wins rule is for
 * inheritance, not for two edits both claiming to be new.
 */
function refuseAdditiveCollisions(
  prior: readonly StructureProperty[],
  declared: readonly StructureProperty[],
): Problem[] {
  const existingKeys = new Set(prior.map((property) => property.key));
  const seen = new Set<string>();
  const problems: Problem[] = [];

  declared.forEach((property, index) => {
    if (existingKeys.has(property.key) || seen.has(property.key)) {
      problems.push({
        path: `fields[${String(index)}].key`,
        code: 'collision',
        message: `A field already uses '${property.key}'. Choose a different key for this field.`,
      });
    }
    seen.add(property.key);
  });

  return problems;
}

/**
 * Runs `refuseViews` once per view, with a precise `views[i]` path, rather than once over the
 * whole array with the bare path `views`. `refuseViews` itself still stops at the first reason
 * within one call - it mirrors Core's own `Refuse`, which does the same - so calling it once for
 * the whole array would let a second bad view go unreported whenever an earlier one already
 * failed. One call per view is what keeps the "every view gets its own chance to fail" promise
 * `validateSpec` makes.
 */
function pushViewProblems(
  views: readonly StructureView[],
  effective: readonly StructureProperty[],
  problems: Problem[],
): void {
  views.forEach((view, index) => {
    const reason = refuseViews([view], effective, null);
    if (reason !== null) {
      problems.push({ path: `views[${String(index)}]`, code: 'views', message: reason });
    }
  });
}

function report(problems: Problem[], stats: ValidationReport['stats']): ValidationReport {
  return { ok: problems.length === 0, problems, warnings: [], stats };
}

function validateCreateStructured(raw: unknown, context: ValidationContext): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = structuredSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return report(zodIssuesToProblems(parsed.error), stats);
  }
  const spec = parsed.data;
  const problems: Problem[] = [];

  const priorFields = spec.inherit ? context.inheritedFields : [];
  const declared = compileFieldSpecs(spec.fields, priorFields, 'fields', problems);
  const effective = mergeProperties(priorFields, declared);

  const schemaProblem = refuseSchema({ properties: effective, inherit: spec.inherit });
  if (schemaProblem !== null) {
    problems.push({ path: 'fields', code: 'schema', message: schemaProblem });
  }

  const scope: RefScope = {
    existing: priorFields,
    added: declared.map((property) => ({ key: property.key, label: property.label })),
  };
  const views = (spec.views ?? []).map((view, index) =>
    compileViewForValidation(view, scope, index, problems),
  );
  pushViewProblems(views, effective, problems);

  return report(problems, { ...stats, fields: spec.fields.length, views: views.length });
}

function validateAddView(raw: unknown, context: ValidationContext): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = viewSetupSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return report(zodIssuesToProblems(parsed.error), stats);
  }
  const spec = parsed.data;
  const problems: Problem[] = [];

  const priorDeclared = context.existing?.declared ?? [];
  const priorEffective = mergeProperties(context.inheritedFields, priorDeclared);
  const declared = compileFieldSpecs(spec.fields ?? [], priorEffective, 'fields', problems);
  problems.push(...refuseAdditiveCollisions(priorEffective, declared));

  const effective = mergeProperties(priorEffective, declared);
  const schemaProblem = refuseSchema({ properties: effective, inherit: true });
  if (schemaProblem !== null) {
    problems.push({ path: 'fields', code: 'schema', message: schemaProblem });
  }

  const scope: RefScope = {
    existing: priorEffective,
    added: declared.map((property) => ({ key: property.key, label: property.label })),
  };
  const views = spec.views.map((view, index) =>
    compileViewForValidation(view, scope, index, problems),
  );
  pushViewProblems(views, effective, problems);

  return report(problems, { ...stats, fields: (spec.fields ?? []).length, views: views.length });
}

function validateCreateEntries(raw: unknown, context: ValidationContext): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = entriesSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return report(zodIssuesToProblems(parsed.error), stats);
  }
  const spec: EntriesSpec = parsed.data;
  const problems: Problem[] = [];

  const effective = mergeProperties(context.inheritedFields, context.existing?.declared ?? []);
  const scope: RefScope = { existing: effective, added: [] };

  spec.entries.forEach((entry, entryIndex) => {
    if (entry.values === undefined) {
      return;
    }
    for (const [ref, value] of Object.entries(entry.values)) {
      const path = `entries[${String(entryIndex)}].values.${ref}`;
      const key = resolveRef(ref, scope, path, problems);
      if (key === null) {
        continue;
      }
      const property = effective.find((candidate) => candidate.key === key);
      if (property === undefined) {
        continue;
      }
      const valueProblem = validateValue(property, value);
      if (valueProblem !== null) {
        problems.push({ path, code: 'value', message: valueProblem });
      }
    }
  });

  return report(problems, { ...stats, entries: spec.entries.length });
}

function validateApplyTemplate(raw: unknown): ValidationReport {
  const stats = statsFromRaw(raw);
  const parsed = applySpecSchema.safeParse(raw);
  if (!parsed.success) {
    return report(zodIssuesToProblems(parsed.error), stats);
  }
  return report([], stats);
}

/**
 * The one entry point every caller uses to check a pet's proposed spec before any write:
 * `runWorkspaceTool` (`packages/companion`, once A.1d wires it in), the approval card, and
 * `nixctl`. Composes a Zod parse (problem paths read like a Zod issue's own), the field compiler,
 * the effective-schema merge (`mergeProperties`), the two ported rule-parity functions
 * (`refuseSchema`, `refuseViews`), and - for entries - `validateValue` against every value a pet
 * proposed.
 *
 * The problem list is exhaustive at the level this function controls: every field-ref resolution,
 * every view, and every entry value gets its own chance to fail, rather than stopping at the
 * first one - a pet correcting one mistake at a time against a request that hides the rest is a
 * worse conversation than one told everything at once. `refuseViews` is called once per compiled
 * view for exactly this reason: it stops at Core's own first reason within one call, so calling it
 * once per view is what keeps a second bad view from going unreported because an earlier one
 * already failed. `refuseSchema`, by contrast, is still one call over the whole schema - Core's
 * own rule is schema-wide (a duplicate key, a cycle) in a way that does not decompose per field -
 * so it still returns only its first reason.
 */
export function validateSpec(
  op: SpecOperation,
  spec: unknown,
  context: ValidationContext,
): ValidationReport {
  switch (op) {
    case 'create_structured':
      return validateCreateStructured(spec, context);
    case 'add_view':
      return validateAddView(spec, context);
    case 'create_entries':
      return validateCreateEntries(spec, context);
    case 'apply_template':
      return validateApplyTemplate(spec);
  }
}
