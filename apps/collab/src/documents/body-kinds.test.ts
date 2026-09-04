import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { canvasStrategy, noteStrategy, sheetStrategy, strategyFor } from './body-kinds.ts';
import { judgeCandidate } from './session.ts';

/**
 * The body-kind seam: which strategy answers for which `item.type`, and what each one
 * accepts. The rule under test is ADR-0009's - the type says how a body is drawn, never
 * what an item may contain - so unknown kinds fall back to prose rather than being
 * refused, and a canvas is just a different answer to "does this state still open".
 */

function canvasDocWith(elements: Record<string, unknown>[]): Y.Doc {
  const doc = new Y.Doc();
  const map = doc.getMap('elements');
  for (const element of elements) {
    const id = element.id;
    map.set(typeof id === 'string' ? id : 'missing', element);
  }
  return doc;
}

function element(id: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return { id, type: 'rectangle', version: 1, versionNonce: 7, x: 0, y: 0, ...overrides };
}

function sheetDocWith(cells: Record<string, string>): Y.Doc {
  const doc = new Y.Doc();
  const map = doc.getMap('sheet-cells');
  for (const [key, raw] of Object.entries(cells)) {
    map.set(key, { raw });
  }
  return doc;
}

describe('body-kind dispatch', () => {
  it('answers prose for a note, a scene for a canvas, cells for a spreadsheet, and prose for anything unheard of', () => {
    expect(strategyFor('note')).toBe(noteStrategy);
    expect(strategyFor('canvas')).toBe(canvasStrategy);
    expect(strategyFor('spreadsheet')).toBe(sheetStrategy);
    // The open set: a kind minted after this build behaves as every body behaved before
    // kinds were dispatched at all, instead of being refused for its novelty.
    expect(strategyFor('whiteboard-2029')).toBe(noteStrategy);
    expect(strategyFor('')).toBe(noteStrategy);
  });

  it('accepts a well-formed scene and measures it in elements', () => {
    const doc = canvasDocWith([element('a'), element('b'), element('c')]);

    expect(canvasStrategy.measure(doc)).toMatchObject({ nodes: 3 });
    doc.destroy();
  });

  it('refuses an element with a missing or non-integral reconciliation contract', () => {
    // Without id, version and versionNonce, two whole-element writes cannot order
    // deterministically - the merge would produce a scene some client cannot reconcile.
    const missingVersion = canvasDocWith([{ id: 'a', type: 'rectangle', versionNonce: 1 }]);
    const idMismatch = canvasDocWith([element('a')]);
    idMismatch.getMap('elements').set('b', element('not-b'));
    const fractionalVersion = canvasDocWith([element('fractional', { version: 1.5 })]);
    const negativeNonce = canvasDocWith([element('negative', { versionNonce: -1 })]);

    expect(canvasStrategy.measure(missingVersion)).toBeNull();
    expect(canvasStrategy.measure(idMismatch)).toBeNull();
    expect(canvasStrategy.measure(fractionalVersion)).toBeNull();
    expect(canvasStrategy.measure(negativeNonce)).toBeNull();
    missingVersion.destroy();
    idMismatch.destroy();
    fractionalVersion.destroy();
    negativeNonce.destroy();
  });

  it('judges a canvas update by the canvas rules, not the prose ones', () => {
    const resident = canvasDocWith([element('a')]);

    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(resident));
    editor.getMap('elements').set('b', element('b'));
    const goodUpdate = Y.encodeStateAsUpdate(editor, Y.encodeStateVector(resident));

    expect(judgeCandidate(resident, goodUpdate, { strategy: canvasStrategy })).toMatchObject({
      ok: true,
    });
    // The same update judged as prose would be refused: the map is not a fragment. That
    // asymmetry is the whole reason dispatch exists.
    expect(judgeCandidate(resident, goodUpdate, { strategy: noteStrategy })).toMatchObject({
      ok: false,
      refusal: { code: 'document_does_not_parse' },
    });

    resident.destroy();
    editor.destroy();
  });

  it('enforces the element ceiling with the same growth rule prose gets', () => {
    const resident = canvasDocWith([element('a'), element('b'), element('c')]);
    const ceiling = { nodes: 2, bytes: canvasStrategy.ceilings.bytes };

    const grower = new Y.Doc();
    Y.applyUpdate(grower, Y.encodeStateAsUpdate(resident));
    grower.getMap('elements').set('d', element('d'));
    const growth = Y.encodeStateAsUpdate(grower, Y.encodeStateVector(resident));
    expect(
      judgeCandidate(resident, growth, { strategy: canvasStrategy, ceilings: ceiling }),
    ).toMatchObject({
      ok: false,
      refusal: { code: 'document_too_many_nodes' },
    });

    const shrinker = new Y.Doc();
    Y.applyUpdate(shrinker, Y.encodeStateAsUpdate(resident));
    shrinker.getMap('elements').delete('a');
    const shrinkage = Y.encodeStateAsUpdate(shrinker, Y.encodeStateVector(resident));
    expect(
      judgeCandidate(resident, shrinkage, { strategy: canvasStrategy, ceilings: ceiling }),
    ).toMatchObject({ ok: true });

    resident.destroy();
    grower.destroy();
    shrinker.destroy();
  });

  it('accepts the production canvas ceiling and refuses the next merged element', () => {
    const resident = new Y.Doc();
    const residentMap = resident.getMap('elements');
    for (let index = 0; index < canvasStrategy.ceilings.nodes; index += 1) {
      residentMap.set(`shape-${String(index)}`, element(`shape-${String(index)}`));
    }
    expect(canvasStrategy.measure(resident)).toMatchObject({ nodes: 10_000 });

    const grower = new Y.Doc();
    Y.applyUpdate(grower, Y.encodeStateAsUpdate(resident));
    grower.getMap('elements').set('shape-over-ceiling', element('shape-over-ceiling'));
    const growth = Y.encodeStateAsUpdate(grower, Y.encodeStateVector(resident));

    expect(judgeCandidate(resident, growth, { strategy: canvasStrategy })).toMatchObject({
      ok: false,
      refusal: { code: 'document_too_many_nodes' },
    });
    resident.destroy();
    grower.destroy();
  });

  it('materialises a scene as JSON plus the words written on it', () => {
    const doc = canvasDocWith([
      element('shape'),
      element('label', { type: 'text', text: 'The plan' }),
      element('note', { type: 'text', text: 'Ship it' }),
    ]);

    const materialized = canvasStrategy.materialize(doc);

    expect(materialized.json).toMatchObject({
      elements: { shape: { id: 'shape' }, label: { text: 'The plan' } },
    });
    // Geometry has nothing to say to a search index; the text elements are the document.
    expect(materialized.plaintext).toBe('The plan\nShip it');
    doc.destroy();
  });

  it('extracts canonical Excalidraw item markers and transitional cards as canvas links', () => {
    const source = '10000000-0000-4000-8000-000000000001';
    const firstTarget = '20000000-0000-4000-8000-000000000001';
    const secondTarget = '30000000-0000-4000-8000-000000000001';
    const doc = canvasDocWith([
      element('canonical', {
        customData: { nix: { kind: 'item', itemId: firstTarget, label: 'First' } },
      }),
      element('transitional', { type: 'card', itemId: firstTarget }),
      // The canonical representation wins while an element temporarily carries both formats.
      element('mixed', {
        type: 'card',
        itemId: firstTarget,
        customData: { nix: { kind: 'item', itemId: secondTarget } },
      }),
      element('file', {
        type: 'image',
        fileId: firstTarget,
        customData: { nix: { kind: 'file', itemId: firstTarget } },
      }),
      element('transitional-file', { type: 'image', imageItemId: secondTarget }),
      element('deleted', {
        isDeleted: true,
        customData: { nix: { kind: 'item', itemId: firstTarget } },
      }),
      element('self', { customData: { nix: { kind: 'item', itemId: source } } }),
      element('malformed', { customData: { nix: { kind: 'item', itemId: 'not-a-uuid' } } }),
      element('arbitrary', { customData: { itemId: firstTarget } }),
    ]);

    const materialized = canvasStrategy.materialize(doc);
    if (canvasStrategy.extractLinks === undefined) {
      throw new Error('The canvas strategy did not expose links.');
    }

    expect([...canvasStrategy.extractLinks(materialized.json, source)]).toEqual([
      [firstTarget, 3],
      [secondTarget, 2],
    ]);
    doc.destroy();
  });

  it('materialises an empty or absent scene as an empty scene, not a failure', () => {
    const doc = new Y.Doc();

    expect(canvasStrategy.materialize(doc)).toEqual({
      json: { elements: {} },
      plaintext: '',
    });
    doc.destroy();
  });

  it('accepts a well-formed sheet and measures it in cells', () => {
    const doc = sheetDocWith({ A1: '1', B1: '=A1*2', A2: 'label' });

    expect(sheetStrategy.measure(doc)).toMatchObject({ nodes: 3 });
    doc.destroy();
  });

  it('refuses a cell map that is not a sheet at all', () => {
    const notASheet = sheetDocWith({ 'not-a-cell-address': '1' });

    expect(sheetStrategy.measure(notASheet)).toBeNull();
    notASheet.destroy();
  });

  it('refuses a sheet it cannot evaluate within its op budget, the same as malformed content', () => {
    const doc = new Y.Doc();
    // A single formula whose range evaluation alone spends more than the op budget - each
    // cell a SUM range touches costs one op, and this range touches millions.
    doc.getMap('sheet-cells').set('A1', { raw: '=SUM(A2:ZZ9999)' });

    // Structurally sound, but the strategy still says null: a sheet this build cannot
    // finish evaluating is as unopenable as one it cannot parse.
    expect(sheetStrategy.measure(doc)).toBeNull();
    doc.destroy();
  });

  it('accepts a sheet whose formulas merely error, because errors are values', () => {
    const doc = sheetDocWith({ A1: '=1/0', B1: '=A1' });

    expect(sheetStrategy.measure(doc)).not.toBeNull();
    doc.destroy();
  });

  it('judges a sheet update by the sheet rules, not the prose ones', () => {
    const resident = sheetDocWith({ A1: '1' });

    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(resident));
    editor.getMap('sheet-cells').set('B1', { raw: '=A1*2' });
    const goodUpdate = Y.encodeStateAsUpdate(editor, Y.encodeStateVector(resident));

    expect(judgeCandidate(resident, goodUpdate, { strategy: sheetStrategy })).toMatchObject({
      ok: true,
    });
    // The same update judged as prose would be refused: the map is not a fragment. That
    // asymmetry is the whole reason dispatch exists.
    expect(judgeCandidate(resident, goodUpdate, { strategy: noteStrategy })).toMatchObject({
      ok: false,
      refusal: { code: 'document_does_not_parse' },
    });

    resident.destroy();
    editor.destroy();
  });

  it('enforces the cell ceiling with the same growth rule prose gets', () => {
    const resident = sheetDocWith({ A1: '1', A2: '2', A3: '3' });
    const ceiling = { nodes: 2, bytes: sheetStrategy.ceilings.bytes };

    const grower = new Y.Doc();
    Y.applyUpdate(grower, Y.encodeStateAsUpdate(resident));
    grower.getMap('sheet-cells').set('A4', { raw: '4' });
    const growth = Y.encodeStateAsUpdate(grower, Y.encodeStateVector(resident));
    expect(
      judgeCandidate(resident, growth, { strategy: sheetStrategy, ceilings: ceiling }),
    ).toMatchObject({
      ok: false,
      refusal: { code: 'document_too_many_nodes' },
    });

    const shrinker = new Y.Doc();
    Y.applyUpdate(shrinker, Y.encodeStateAsUpdate(resident));
    shrinker.getMap('sheet-cells').delete('A1');
    const shrinkage = Y.encodeStateAsUpdate(shrinker, Y.encodeStateVector(resident));
    expect(
      judgeCandidate(resident, shrinkage, { strategy: sheetStrategy, ceilings: ceiling }),
    ).toMatchObject({ ok: true });

    resident.destroy();
    grower.destroy();
    shrinker.destroy();
  });

  it('materialises evaluated values as plaintext and raw cells as json', () => {
    const doc = sheetDocWith({ A1: '2', B1: '=A1*3' });

    const materialized = sheetStrategy.materialize(doc);

    expect(materialized.json).toMatchObject({ body: 'sheet', cells: { A1: '2', B1: '=A1*3' } });
    expect(materialized.plaintext).toBe('2\t6');
    doc.destroy();
  });

  it('materialises an empty or absent sheet as empty, not a failure', () => {
    const doc = new Y.Doc();

    expect(sheetStrategy.materialize(doc)).toMatchObject({ json: { cells: {} }, plaintext: '' });
    doc.destroy();
  });
});

describe('the structural floor', () => {
  /** A fragment holding an element the schema has never heard of: broken, but not empty. */
  function unknownNode(): Y.Doc {
    const state = new Y.Doc();
    state.getXmlFragment('default').insert(0, [new Y.XmlElement('nodeThisBuildHasNeverHeardOf')]);
    return state;
  }

  it('puts a paragraph back into a fragment that holds nothing', () => {
    // `doc` is `block+`, so a fragment with no children is the one shape the schema refuses for
    // a reason that is not about content at all - and the Yjs undo manager can reach it from
    // below, where ProseMirror's own floor does not apply.
    const state = new Y.Doc();

    expect(noteStrategy.measure(state)).toBeNull();
    expect(noteStrategy.repair?.(state)).toBe(true);

    expect(state.getXmlFragment('default').length).toBe(1);
    expect(noteStrategy.measure(state)).not.toBeNull();
    state.destroy();
  });

  it('declines a document whose fault is its content rather than its floor', () => {
    // The narrowness is the point: adding a paragraph beside a node the schema cannot read would
    // not make the document parse, it would only make the refusal harder to read.
    const state = unknownNode();

    expect(noteStrategy.repair?.(state)).toBe(false);
    state.destroy();
  });

  it('is not offered by kinds whose empty state is a legitimate document', () => {
    // An empty canvas is a canvas and an empty sheet is a sheet. Neither has a floor to fall
    // through, so neither carries a repair that would never fire.
    expect(Object.hasOwn(canvasStrategy, 'repair')).toBe(false);
    expect(Object.hasOwn(sheetStrategy, 'repair')).toBe(false);
  });

  it('accepts an emptying update rather than refusing it, and says it mended one', () => {
    // The bug this closes: refusing the emptying leaves the client holding a document it cannot
    // edit its way out of, because every subsequent update merges onto the same empty fragment
    // and is refused for the same reason. Accepting it with the floor restored is the way out.
    const resident = new Y.Doc();
    resident.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);

    const emptying = new Y.Doc();
    Y.applyUpdate(emptying, Y.encodeStateAsUpdate(resident));
    const before = Y.encodeStateVector(emptying);
    emptying.getXmlFragment('default').delete(0, 1);

    const verdict = judgeCandidate(resident, Y.encodeStateAsUpdate(emptying, before), {
      strategy: noteStrategy,
    });

    expect(verdict).toMatchObject({ ok: true, repair: true });
    resident.destroy();
    emptying.destroy();
  });

  it('leaves the resident document untouched while judging one', () => {
    // The contract the whole function rests on: everything is learned from throwaway forks, so a
    // caller may treat any verdict as having changed nothing. A repair that leaked into the
    // resident here would apply the update twice at the call site.
    const resident = new Y.Doc();
    resident.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);

    const emptying = new Y.Doc();
    Y.applyUpdate(emptying, Y.encodeStateAsUpdate(resident));
    const before = Y.encodeStateVector(emptying);
    emptying.getXmlFragment('default').delete(0, 1);

    expect(
      judgeCandidate(resident, Y.encodeStateAsUpdate(emptying, before), { strategy: noteStrategy }),
    ).toMatchObject({ ok: true, repair: true });

    expect(resident.getXmlFragment('default').length).toBe(1);
    resident.destroy();
    emptying.destroy();
  });

  it('refuses an update to a document that was never prose, rather than inventing a paragraph', () => {
    // The gate that keeps this a floor and not a catch-all. A canvas keeps its scene in a Y.Map
    // and leaves the prose fragment empty, so judged as prose it looks exactly like an emptied
    // note - and answering a client that is talking about the wrong document by writing it a
    // blank paragraph would be a worse failure than the refusal it replaced.
    const canvas = canvasDocWith([element('a')]);
    const resident = new Y.Doc();

    const verdict = judgeCandidate(resident, Y.encodeStateAsUpdate(canvas), {
      strategy: noteStrategy,
    });

    expect(verdict).toMatchObject({ ok: false, refusal: { code: 'document_does_not_parse' } });
    canvas.destroy();
    resident.destroy();
  });

  it('still refuses a document the floor was not the cause of, with its diagnosis intact', () => {
    const reasons: string[] = [];
    const resident = new Y.Doc();

    const verdict = judgeCandidate(resident, Y.encodeStateAsUpdate(unknownNode()), {
      strategy: noteStrategy,
      diagnose: (reason) => reasons.push(reason),
    });

    expect(verdict).toMatchObject({ ok: false });
    expect(reasons[0]).toContain('fragment held: nodeThisBuildHasNeverHeardOf');
    resident.destroy();
  });
});
