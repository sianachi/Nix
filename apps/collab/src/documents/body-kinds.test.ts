import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { canvasStrategy, noteStrategy, strategyFor } from './body-kinds.ts';
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

describe('body-kind dispatch', () => {
  it('answers prose for a note, a scene for a canvas, and prose for anything unheard of', () => {
    expect(strategyFor('note')).toBe(noteStrategy);
    expect(strategyFor('canvas')).toBe(canvasStrategy);
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

    expect(judgeCandidate(resident, goodUpdate, canvasStrategy)).toEqual({ ok: true });
    // The same update judged as prose would be refused: the map is not a fragment. That
    // asymmetry is the whole reason dispatch exists.
    expect(judgeCandidate(resident, goodUpdate, noteStrategy)).toMatchObject({
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
    expect(judgeCandidate(resident, growth, canvasStrategy, ceiling)).toMatchObject({
      ok: false,
      refusal: { code: 'document_too_many_nodes' },
    });

    const shrinker = new Y.Doc();
    Y.applyUpdate(shrinker, Y.encodeStateAsUpdate(resident));
    shrinker.getMap('elements').delete('a');
    const shrinkage = Y.encodeStateAsUpdate(shrinker, Y.encodeStateVector(resident));
    expect(judgeCandidate(resident, shrinkage, canvasStrategy, ceiling)).toEqual({ ok: true });

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
});
