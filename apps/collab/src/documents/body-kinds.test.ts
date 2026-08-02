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

  it('refuses an element missing its reconciliation contract', () => {
    // Without id, version and versionNonce, two whole-element writes cannot order
    // deterministically - the merge would produce a scene some client cannot reconcile.
    const missingVersion = canvasDocWith([{ id: 'a', type: 'rectangle', versionNonce: 1 }]);
    const idMismatch = canvasDocWith([element('a')]);
    idMismatch.getMap('elements').set('b', element('not-b'));

    expect(canvasStrategy.measure(missingVersion)).toBeNull();
    expect(canvasStrategy.measure(idMismatch)).toBeNull();
    missingVersion.destroy();
    idMismatch.destroy();
  });

  it('judges a canvas update by the canvas rules, not the prose ones', () => {
    const resident = canvasDocWith([element('a')]);

    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(resident));
    editor.getMap('elements').set('b', element('b'));
    const goodUpdate = Y.encodeStateAsUpdate(editor, Y.encodeStateVector(resident));

    expect(judgeCandidate(resident, goodUpdate, { strategy: canvasStrategy })).toEqual({
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
    ).toEqual({ ok: true });

    resident.destroy();
    grower.destroy();
    shrinker.destroy();
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

    expect(judgeCandidate(resident, goodUpdate, { strategy: sheetStrategy })).toEqual({ ok: true });
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
    ).toEqual({ ok: true });

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
