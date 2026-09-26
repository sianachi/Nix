import type { FieldSpec } from '../spec/field.js';
import { keyFor } from '../spec/keys.js';
import type { StructureProperty } from '../types.js';
import { mergeProperties } from '../vocabulary/merge-properties.js';
import type { Blueprint, Node } from './schema.js';

/**
 * Compiles one node's own `fields` into `StructureProperty`s, without resolving a rollup's
 * `source` reference: that reference names a property on the node's *children*
 * (architecture 4 check 9), which this function - building the map those children's effective
 * schemas live in - cannot yet look up. The raw ref text is carried through unresolved, in
 * `source`, exactly as written; `validate.ts`'s rollup check resolves it once every node's
 * effective schema is known.
 */
function compileNodeOwnProperties(fields: readonly FieldSpec[] | undefined): StructureProperty[] {
  return (fields ?? []).map((field) => ({
    key: keyFor(field),
    label: field.label,
    type: field.type,
    options: field.options ?? [],
    required: field.required ?? false,
    expression: field.type === 'formula' ? (field.formula ?? null) : null,
    aggregate: field.type === 'rollup' ? (field.rollup?.aggregate ?? null) : null,
    source: field.type === 'rollup' ? (field.rollup?.source ?? null) : null,
  }));
}

/**
 * The effective schema in force at every node of a blueprint, nearest-wins down the tree
 * (architecture 4 check 4, reusing `mergeProperties` per the architecture's own instruction to
 * move it here rather than keep a second copy).
 *
 * A node's effective schema is its own declared fields merged onto what its parent hands down;
 * `inherit: false` cuts the chain there - the node's effective schema becomes its own fields only,
 * and its children inherit from it, not from anything above it, exactly as architecture 2.3 states
 * for the flat `inherit` flag. `inheritedFields` seeds the root - `[]` for a sandbox build, or the
 * schema already in effect where the blueprint would land, per `ValidationContext`.
 */
export function effectiveSchemaPerNode(
  bp: Blueprint,
  inheritedFields: readonly StructureProperty[],
): Map<string, StructureProperty[]> {
  const result = new Map<string, StructureProperty[]>();

  function visit(node: Node, ancestorEffective: readonly StructureProperty[]): void {
    const base = node.inherit === false ? [] : ancestorEffective;
    const own = compileNodeOwnProperties(node.fields);
    const effective = mergeProperties(base, own);
    result.set(node.id, effective);
    for (const child of node.children ?? []) {
      visit(child, effective);
    }
  }

  visit(bp.root, inheritedFields);
  return result;
}

/** Every node of a blueprint that declares at least one view - a container, in tree order. */
export function containerNodes(bp: Blueprint): Node[] {
  const containers: Node[] = [];

  function visit(node: Node): void {
    if (node.views !== undefined && node.views.length > 0) {
      containers.push(node);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  }

  visit(bp.root);
  return containers;
}
