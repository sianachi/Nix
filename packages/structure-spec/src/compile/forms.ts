import type { Cond, FormSpec } from '../spec/form.js';
import type {
  StructureForm,
  StructureFormBlock,
  StructureFormCondition,
  StructureFormPage,
  StructureProperty,
} from '../types.js';
import { resolveKey } from './resolve.js';

/**
 * Compiles one `showWhen` condition into a `StructureFormCondition`. A condition's `field` names a
 * property (architecture 2.3), but a compiled condition points at the *block* that collects it
 * (`StructureFormCondition.fieldBlockId`), so this resolves the field to a key and then looks that
 * key up in `blocksByField` - the field blocks compiled so far, earlier pages and earlier blocks on
 * this page only (`compileForm` below never adds a block's own field to that map until after the
 * block's condition has been compiled, and never adds a page's blocks before its own page
 * conditions are compiled). A reference to the same or a later block therefore has no entry yet and
 * throws, which is what the "conditions reference earlier blocks only" test exercises.
 */
function compileCond(
  cond: Cond,
  effective: readonly StructureProperty[],
  addedKeys: ReadonlySet<string> | undefined,
  blocksByField: ReadonlyMap<string, string>,
): StructureFormCondition {
  const key = resolveKey(cond.field, effective, addedKeys);
  const fieldBlockId = blocksByField.get(key);
  if (fieldBlockId === undefined) {
    throw new Error(
      `A show-when condition references field "${cond.field}", which has no earlier field block.`,
    );
  }
  return { fieldBlockId, operator: cond.op, value: cond.value ?? null };
}

/**
 * Compiles a `FormSpec` into a `StructureForm`: page ids `p1..`, block ids `b1..` running
 * sequentially across the whole form rather than resetting per page, per architecture 2.3. The
 * model never writes these ids itself - the pet gives a field its label and its position, and this
 * assigns the wire ids the same way every compiled view does.
 *
 * `addedKeys` is threaded straight through to `resolveKey` (see `views.ts`'s doc comment on the
 * same parameter) - a form is always compiled as part of a view, so it resolves field references
 * under the same rule the rest of that view does.
 */
export function compileForm(
  spec: FormSpec,
  effective: readonly StructureProperty[],
  addedKeys?: ReadonlySet<string>,
): StructureForm {
  const blocksByField = new Map<string, string>();
  let blockCounter = 0;

  const pages: StructureFormPage[] = spec.pages.map((pageSpec, pageIndex) => {
    const visibleWhen = (pageSpec.showWhen ?? []).map((cond) =>
      compileCond(cond, effective, addedKeys, blocksByField),
    );

    const blocks: StructureFormBlock[] = pageSpec.blocks.map((blockSpec) => {
      blockCounter += 1;
      const id = `b${blockCounter.toString()}`;

      if ('field' in blockSpec) {
        const key = resolveKey(blockSpec.field, effective, addedKeys);
        const property = effective.find((candidate) => candidate.key === key);
        const block: StructureFormBlock = {
          id,
          kind: 'field',
          propertyKey: key,
          text: property?.label ?? blockSpec.field,
          help: blockSpec.help ?? null,
          required: blockSpec.required ?? false,
          identityRole: blockSpec.identity ?? null,
          visibleWhen: (blockSpec.showWhen ?? []).map((cond) =>
            compileCond(cond, effective, addedKeys, blocksByField),
          ),
        };
        blocksByField.set(key, id);
        return block;
      }

      if ('heading' in blockSpec) {
        return {
          id,
          kind: 'heading',
          propertyKey: null,
          text: blockSpec.heading,
          help: null,
          required: false,
          identityRole: null,
          visibleWhen: [],
        };
      }

      return {
        id,
        kind: 'paragraph',
        propertyKey: null,
        text: blockSpec.paragraph,
        help: null,
        required: false,
        identityRole: null,
        visibleWhen: [],
      };
    });

    return {
      id: `p${(pageIndex + 1).toString()}`,
      title: pageSpec.title,
      description: pageSpec.description ?? null,
      visibleWhen,
      blocks,
    };
  });

  let titleFieldBlockId: string | null = null;
  if (spec.title?.from === 'field') {
    const key = resolveKey(spec.title.field, effective, addedKeys);
    const blockId = blocksByField.get(key);
    if (blockId === undefined) {
      throw new Error(
        `The form's title field "${spec.title.field}" has no field block collecting it.`,
      );
    }
    titleFieldBlockId = blockId;
  }

  return {
    pages,
    titleMode: titleFieldBlockId !== null ? 'field' : 'generated',
    titleFieldBlockId,
    confirmationTitle: spec.confirmation?.title ?? 'Response received',
    confirmationMessage: spec.confirmation?.message ?? 'Your response has been added.',
  };
}
