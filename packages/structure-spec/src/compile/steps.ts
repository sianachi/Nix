import type { StructureProperty, StructureSchema, StructureView } from '../types.js';

/**
 * A recurrence rule, compiled from a spec into the shape Core's `setRecurrence` takes
 * (`packages/api-client/src/resources/recurrence.ts:30-38`): `weekdays` is `null` unless the
 * frequency is weekly, and `until` is `null` when absent (plan note 4). `RecurrenceSpec` itself is
 * a Phase B spec (task B.2) and is not defined here - the shape this `Step` variant carries is
 * fixed independently of when the spec that produces it lands.
 */
export interface CompiledRecurrenceRule {
  freq: string;
  interval: number;
  weekdays: number[] | null;
  until: string | null;
}

/** A habit's check-in settings, compiled from a blueprint node's `habit` field (architecture 2.3). */
export interface CompiledHabitSettings {
  frequency: string;
  weekdays: number[] | null;
  startDate: string;
  timezone: string;
  target: number;
  unit: string;
}

/**
 * Where a write step lands: an existing item by id, or a not-yet-created blueprint node by its
 * local id. The build planner (task C.3a) resolves a `nodeId` target against its ledger of ids it
 * has already created in this build; every other caller supplies `itemId` directly.
 */
export type StepTarget = { itemId: string } | { nodeId: string };

/**
 * One write (or the one read-free setup step, `ensureSandbox`) the compiler emits from a spec.
 * `@nix/companion`'s executor (task A.4 onward) walks a `Step[]` in order, resolving any `nodeId`
 * target against the ids it has created so far, and turns each into the matching Core or Collab
 * call. The card this array is rendered from before approval (architecture 1.2) is built from the
 * same `Step[]`, so what is previewed is exactly what runs.
 *
 * `captureTemplate` and `applyTemplate` are reserved here with no extra fields yet: their shapes
 * are filled in by tasks A.5 and D.2, which extend this union rather than declaring their own.
 */
export type Step =
  | {
      kind: 'createStructuredItem';
      parentId: string | null;
      title: string;
      schema: StructureSchema;
      views: StructureView[];
      defaultViewId: string;
      nodeId?: string;
      sample?: boolean;
      /** Blueprint root is attached to the resolved Pet drafts sandbox. */
      sandboxParent?: true;
      /** Blueprint child is attached to this previously-created blueprint node. */
      parentNodeId?: string;
    }
  | {
      kind: 'appendViewSetup';
      itemId: string;
      properties: StructureProperty[];
      views: StructureView[];
      makeDefault: boolean;
    }
  | {
      kind: 'replaceViewSetup';
      itemId: string;
      viewId: string;
      schema: StructureSchema;
      originalPropertyKeys: string[];
      views: StructureView[];
    }
  | {
      kind: 'createItem';
      parentId: string | null;
      title: string;
      properties: Record<string, unknown> | null;
      nodeId?: string;
      sample?: boolean;
      /** Blueprint root is attached to the resolved Pet drafts sandbox. */
      sandboxParent?: true;
      /** Blueprint child is attached to this previously-created blueprint node. */
      parentNodeId?: string;
    }
  | { kind: 'appendBody'; target: StepTarget; markdown: string }
  | { kind: 'setRecurrence'; target: StepTarget; rule: CompiledRecurrenceRule }
  | { kind: 'setHabit'; target: StepTarget; settings: CompiledHabitSettings }
  | { kind: 'ensureSandbox' }
  | { kind: 'captureTemplate' }
  | { kind: 'applyTemplate' };

/**
 * Every `Step` kind exists here as a key, `satisfies Record<Step['kind'], true>` - so a variant
 * added to the `Step` union above and forgotten here fails to typecheck instead of silently never
 * appearing in `STEP_KINDS`.
 */
const STEP_KIND_KEYS = {
  createStructuredItem: true,
  appendViewSetup: true,
  replaceViewSetup: true,
  createItem: true,
  appendBody: true,
  setRecurrence: true,
  setHabit: true,
  ensureSandbox: true,
  captureTemplate: true,
  applyTemplate: true,
} satisfies Record<Step['kind'], true>;

export const STEP_KINDS: readonly Step['kind'][] = Object.keys(STEP_KIND_KEYS) as Step['kind'][];

/**
 * Whether a step performs a Core or Collab write once executed.
 *
 * Every step kind the compiler currently emits is a write - `ensureSandbox` included, since even
 * though it is a no-op when `Pet drafts` already exists, that is a fact only the executor's fresh
 * read at execution time can know, not something the compiler can decide while building the plan.
 * The function stays a real predicate, not a constant `true`, so a step kind added later that is
 * genuinely read-only (for example a local-only check) has somewhere to say so without every
 * existing caller of `isWriteStep` needing to change.
 */
export function isWriteStep(step: Step): boolean {
  void step;
  return true;
}
