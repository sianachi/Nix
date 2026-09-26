import type { z } from 'zod';

import type { StructureProperty, StructureView } from '../types.js';
import type { FieldSpec } from '../spec/field.js';
import {
  type EntriesSpec,
  applySpecSchema,
  entriesSpecSchema,
  structuredSpecSchema,
  viewSetupSpecSchema,
} from '../spec/operations.js';
import type { FieldRefResolution } from '../spec/refs.js';
import type { ViewSpec } from '../spec/view.js';
import { mergeProperties } from '../vocabulary/merge-properties.js';
import { compileFields } from '../compile/fields.js';
import { compileView } from '../compile/views.js';
import { tryResolveKey } from '../compile/resolve.js';
import { refuseSchema } from './schema-rules.js';
import { refuseViews } from './view-rules.js';
import { validateValue } from './values.js';
import type { Problem, ValidationContext, ValidationReport } from './report.js';

export type SpecOperation = 'create_structured' | 'add_view' | 'create_entries' | 'apply_template';

interface RefScope {
  existing: readonly StructureProperty[];
  added: readonly StructureProperty[];
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
  const resolution = tryResolveKey(
    ref,
    [...scope.existing, ...scope.added],
    new Set(scope.added.map((field) => field.key)),
  );
  if (!resolution.ok) {
    problems.push({ path, code: resolution.code, message: refFailureMessage(ref, resolution) });
    return null;
  }
  return resolution.key;
}

function compileFieldSpecs(
  specs: readonly FieldSpec[],
  existing: readonly StructureProperty[],
  path: string,
  problems: Problem[],
): StructureProperty[] {
  const prior: StructureProperty[] = [];
  const safeSpecs: FieldSpec[] = [];
  for (const [index, field] of specs.entries()) {
    let safeField = field;
    if (field.type === 'rollup' && field.rollup?.source !== undefined) {
      const resolution = tryResolveKey(
        field.rollup.source,
        [...existing, ...prior],
        new Set(prior.map((item) => item.key)),
      );
      if (!resolution.ok) {
        problems.push({
          path: `${path}[${String(index)}].rollup.source`,
          code: resolution.code,
          message: refFailureMessage(field.rollup.source, resolution),
        });
        safeField = { ...field, rollup: { ...field.rollup, source: undefined } };
      }
    }
    safeSpecs.push(safeField);
    prior.splice(0, prior.length, ...compileFields(safeSpecs, { existing }).properties);
  }
  // Compile the full list through the same implementation used by execution. Per-field compilation
  // above only supplies context for rollup FieldRefs and protects reporting from compiler throws.
  return compileFields(safeSpecs, { existing }).properties;
}

function inspectFormRefs(
  view: ViewSpec,
  index: number,
  scope: RefScope,
  problems: Problem[],
): boolean {
  if (view.kind !== 'interactive_form' || view.form === undefined) return true;
  const form = view.form;
  const base = `views[${String(index)}].form`;
  const earlier = new Set<string>();
  let valid = true;
  const inspect = (ref: string, path: string, requireEarlier = false): string | null => {
    const key = resolveRef(ref, scope, path, problems);
    if (key === null) valid = false;
    else if (requireEarlier && !earlier.has(key)) {
      problems.push({
        path,
        code: 'form-order',
        message: `Field '${ref}' must have an earlier field block.`,
      });
      valid = false;
    }
    return key;
  };
  form.pages.forEach((page, pageIndex) => {
    page.showWhen?.forEach((condition, conditionIndex) => {
      inspect(
        condition.field,
        `${base}.pages[${String(pageIndex)}].showWhen[${String(conditionIndex)}].field`,
        true,
      );
    });
    page.blocks.forEach((block, blockIndex) => {
      if (!('field' in block)) return;
      const key = inspect(
        block.field,
        `${base}.pages[${String(pageIndex)}].blocks[${String(blockIndex)}].field`,
      );
      block.showWhen?.forEach((condition, conditionIndex) => {
        inspect(
          condition.field,
          `${base}.pages[${String(pageIndex)}].blocks[${String(blockIndex)}].showWhen[${String(conditionIndex)}].field`,
          true,
        );
      });
      if (key !== null) earlier.add(key);
    });
  });
  if (form.title?.from === 'field') {
    const key = inspect(form.title.field, `${base}.title.field`, true);
    if (key !== null && !earlier.has(key)) {
      problems.push({
        path: `${base}.title.field`,
        code: 'form-order',
        message: `Field '${form.title.field}' needs a field block in the form.`,
      });
      valid = false;
    }
  }
  return valid;
}

function compileViews(
  specs: readonly ViewSpec[],
  effective: readonly StructureProperty[],
  addedKeys: ReadonlySet<string>,
  problems: Problem[],
): StructureView[] {
  const usedIds = new Set<string>();
  const views: StructureView[] = [];
  specs.forEach((spec, index) => {
    const path = `views[${String(index)}]`;
    const scope = {
      existing: effective.filter((field) => !addedKeys.has(field.key)),
      added: effective.filter((field) => addedKeys.has(field.key)),
    };
    let valid = true;
    const check = (ref: string | undefined, suffix: string) => {
      if (ref !== undefined && resolveRef(ref, scope, `${path}.${suffix}`, problems) === null)
        valid = false;
    };
    check(spec.groupBy, 'groupBy');
    check(spec.date, 'date');
    check(spec.endDate, 'endDate');
    check(spec.cover, 'cover');
    check(spec.measureField, 'measureField');
    check(spec.sortBy, 'sortBy');
    spec.columns?.forEach((ref, columnIndex) => {
      check(ref, `columns[${String(columnIndex)}]`);
    });
    spec.filters?.forEach((filter, filterIndex) => {
      check(filter.field, `filters[${String(filterIndex)}].field`);
    });
    valid = inspectFormRefs(spec, index, scope, problems) && valid;
    if (valid) views.push(compileView(spec, effective, usedIds, addedKeys));
  });
  return views;
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
  const localReasons = new Set<string>();
  views.forEach((view, index) => {
    const reason = refuseViews([view], effective, null);
    if (reason !== null) {
      localReasons.add(reason);
      problems.push({ path: `views[${String(index)}]`, code: 'views', message: reason });
    }
  });
  const setReason = refuseViews(views, effective, null);
  if (setReason !== null && !localReasons.has(setReason)) {
    problems.push({ path: 'views', code: 'views', message: setReason });
  }
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

  // Core refuses a child's schema when inherited properties are present too; keep that deliberate
  // stricter check across ancestors, matching the effective schema the operation will compile.
  const schemaProblem = refuseSchema({ properties: effective, inherit: spec.inherit });
  if (schemaProblem !== null) {
    problems.push({ path: 'fields', code: 'schema', message: schemaProblem });
  }

  const addedKeys = new Set(declared.map((property) => property.key));
  const views = compileViews(spec.views ?? [], effective, addedKeys, problems);
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

  const addedKeys = new Set(declared.map((property) => property.key));
  const views = compileViews(spec.views, effective, addedKeys, problems);
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
