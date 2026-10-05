import type { FieldsSpec, FormEditSpec, RecurrenceSpec } from '../spec/edits.js';
import { compileFields } from './fields.js';
import { compileForm } from './forms.js';
import type { Step } from './steps.js';
import type { StructureProperty, StructureView } from '../types.js';

export interface AddFieldsContext {
  itemId: string;
  existing: {
    effective: readonly StructureProperty[];
  };
}

/** Compiles new fields to the server-side additive merge endpoint. */
export function compileAddFields(spec: FieldsSpec, context: AddFieldsContext): Step[] {
  const properties = compileFields(spec.fields, {
    existing: context.existing.effective,
  }).properties;
  return [
    {
      kind: 'appendViewSetup',
      itemId: context.itemId,
      properties,
      views: [],
      makeDefault: false,
    },
  ];
}

export interface EditFormContext {
  itemId: string;
  existing: {
    declared: readonly StructureProperty[];
    inherit: boolean;
    effective: readonly StructureProperty[];
    views: readonly StructureView[];
  };
  view: StructureView;
}

/**
 * Replaces only the selected interactive form, carrying its companion view through unchanged.
 * Validation is responsible for refusing an unknown view, a non-form view, or colliding fields.
 */
export function compileEditForm(spec: FormEditSpec, context: EditFormContext): Step[] {
  if (context.view.id !== spec.viewId) {
    throw new Error(`The form view "${spec.viewId}" does not match the view being edited.`);
  }
  if (context.view.kind !== 'interactive_form') {
    throw new Error(`The view "${spec.viewId}" is not an interactive form.`);
  }

  const properties = compileFields(spec.fields ?? [], {
    existing: context.existing.effective,
  }).properties;
  const effective = [...context.existing.effective, ...properties];
  const addedKeys = new Set(properties.map((property) => property.key));
  const editedView: StructureView = {
    ...context.view,
    interactiveForm: compileForm(spec.form, effective, addedKeys),
  };
  const companion =
    context.view.companionViewId === null || context.view.companionViewId === undefined
      ? undefined
      : context.existing.views.find((view) => view.id === context.view.companionViewId);
  if (context.view.companionViewId && companion === undefined) {
    throw new Error(`The companion view "${context.view.companionViewId}" is missing.`);
  }

  return [
    {
      kind: 'replaceViewSetup',
      itemId: context.itemId,
      viewId: context.view.id,
      schema: { properties, inherit: context.existing.inherit },
      originalPropertyKeys: [],
      views: companion === undefined ? [editedView] : [editedView, companion],
    },
  ];
}

export interface CompileRecurrenceContext {
  itemId: string;
}

/** Compiles recurrence to Core's wire shape, dropping weekdays unless the rule is weekly. */
export function compileRecurrence(spec: RecurrenceSpec, context: CompileRecurrenceContext): Step[] {
  return [
    {
      kind: 'setRecurrence',
      target: { itemId: context.itemId },
      rule: {
        freq: spec.frequency,
        interval: spec.interval,
        weekdays: spec.frequency === 'weekly' ? (spec.weekdays ?? null) : null,
        until: spec.until ?? null,
      },
    },
  ];
}
