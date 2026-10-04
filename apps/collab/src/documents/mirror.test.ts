import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { FRAGMENT_NAME, noteStrategy } from './body-kinds.ts';
import { CandidateMirror, judgeCandidate } from './session.ts';

/**
 * The mirror is an optimisation, so the only thing worth asserting about it is that it changes
 * nothing: every verdict it helps reach is the verdict a fresh copy reaches, across exactly the
 * sequences that take it out of step - refusals, a measurement that writes, log catch-up, repair.
 */

function paragraph(text: string): Y.XmlElement {
  const element = new Y.XmlElement('paragraph');
  element.insert(0, [new Y.XmlText(text)]);
  return element;
}

/** An update made by a client that is in sync with the resident. */
function edit(resident: Y.Doc, change: (fragment: Y.XmlFragment) => void): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(resident));
  const vector = Y.encodeStateVector(client);
  change(client.getXmlFragment(FRAGMENT_NAME));
  return Y.encodeStateAsUpdate(client, vector);
}

function text(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.XmlFragment defines its own XML toString.
  return doc.getXmlFragment(FRAGMENT_NAME).toString();
}

describe('the candidate mirror', () => {
  it('reaches the same verdict as a fresh copy, through refusals, catch-up and repair', () => {
    const resident = new Y.Doc();
    resident.getXmlFragment(FRAGMENT_NAME).insert(0, [paragraph('Already here.')]);
    const mirror = new CandidateMirror(resident);

    const steps: { name: string; update: () => Uint8Array; logged?: boolean }[] = [
      {
        name: 'a paragraph',
        update: () =>
          edit(resident, (f) => {
            f.insert(f.length, [paragraph('One.')]);
          }),
      },
      {
        name: 'a node the schema does not know, which measuring writes out of the mirror',
        update: () =>
          edit(resident, (f) => {
            f.insert(f.length, [new Y.XmlElement('mystery')]);
          }),
      },
      {
        name: 'a paragraph after the refusal',
        update: () =>
          edit(resident, (f) => {
            f.insert(f.length, [paragraph('Two.')]);
          }),
      },
      {
        name: 'an update read back from the log',
        update: () =>
          edit(resident, (f) => {
            f.insert(0, [paragraph('From the log.')]);
          }),
        logged: true,
      },
      {
        name: 'a paragraph after catch-up',
        update: () =>
          edit(resident, (f) => {
            f.insert(f.length, [paragraph('Three.')]);
          }),
      },
      {
        name: 'emptying the document, which is repaired',
        update: () =>
          edit(resident, (f) => {
            f.delete(0, f.length);
          }),
      },
      {
        name: 'a paragraph after the repair',
        update: () =>
          edit(resident, (f) => {
            f.insert(f.length, [paragraph('Four.')]);
          }),
      },
    ];

    for (const step of steps) {
      const update = step.update();

      if (step.logged === true) {
        // What catch-up does: applied straight to the resident, never judged.
        Y.applyUpdate(resident, update, 'log');
        continue;
      }

      const fresh = judgeCandidate(resident, update, { strategy: noteStrategy });
      const mirrored = judgeCandidate(resident, update, {
        strategy: noteStrategy,
        scratch: mirror,
      });
      expect(mirrored, step.name).toEqual(fresh);

      // And apply it the way the session does.
      if (mirrored.ok && mirrored.repair) {
        resident.transact(() => {
          Y.applyUpdate(resident, update);
          noteStrategy.repair?.(resident);
        });
      } else if (mirrored.ok) {
        Y.applyUpdate(resident, update);
        mirror.settle();
      }
    }

    // After all of it, the mirror still describes the resident exactly.
    const settled = mirror.fork(Y.encodeStateAsUpdate(new Y.Doc()));
    expect(text(settled)).toBe(text(resident));
    expect(text(resident)).toContain('Four.');
    expect(text(resident)).not.toContain('mystery');
    mirror.destroy();
  });
});
