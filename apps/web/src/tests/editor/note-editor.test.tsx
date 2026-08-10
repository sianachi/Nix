import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import type * as collabSync from '../../editor/collab-sync';
import { NoteEditor } from '../../editor/note-editor';

/**
 * The provider is replaced, and the document it is handed is kept.
 *
 * `NoteEditor` builds its own `Y.Doc` with `useState`, so there is no way in from outside - and
 * that document is the whole subject. `startCollabSync` is the one place it is passed anywhere,
 * which makes the provider the natural seam: stub it, keep what it was given, and the test can ask
 * the real component's real document what is in it.
 */
let captured: Y.Doc | null = null;

vi.mock('../../editor/collab-sync', async () => {
  const actual = await vi.importActual<typeof collabSync>('../../editor/collab-sync');
  return {
    ...actual,
    startCollabSync: (options: { doc: Y.Doc }) => {
      captured = options.doc;
      return { awareness: null, destroy: () => undefined };
    },
  };
});

vi.mock('../../auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve('token') }),
}));

/**
 * The one thing about this editor that cannot be inspected by looking at it: whether what somebody
 * types reaches the shared document.
 *
 * This exists because it did not, for a new note, for as long as the collaborative editor has. The
 * Yjs plugins were added with `registerPlugin` inside `onCreate` - after the editor already
 * existed - and a binding established that late never carried ProseMirror's content into Yjs. An
 * *existing* note hid it completely: the server's own state arrives and drives Yjs to ProseMirror,
 * so the binding looks alive in the direction anybody would check. A new one had nothing to
 * receive, so its fragment stayed empty, every update the client sent merged to an empty document,
 * and the collaboration service refused all of them with `document_does_not_parse` while
 * `head_seq` sat at zero.
 *
 * Nothing about that is visible in the interface. The text stays on screen, the footer says live,
 * and the work is gone on reload.
 */

beforeEach(() => {
  captured = null;
});

/** Renders the editor and returns the shared document it handed the provider. */
async function open(): Promise<Y.Doc> {
  render(<NoteEditor itemId="00000000-0000-4000-8000-000000000001" />);

  await waitFor(() => {
    expect(captured).not.toBeNull();
  });

  const doc = captured;
  if (doc === null) {
    throw new Error('The editor never handed its document to the provider.');
  }
  return doc;
}

describe('a note nobody has typed into yet', () => {
  it('puts a change made through the interface into the shared document', async () => {
    // **The regression, stated exactly.** With the Yjs binding supplied at construction, an edit
    // reaches the shared fragment. With the plugins registered afterwards in `onCreate` - which is
    // where they lived - it never did: the fragment stayed empty for the life of the note, every
    // update the client sent merged to a document with no blocks in it, and the collaboration
    // service refused all of them with `document_does_not_parse` while `head_seq` sat at zero.
    //
    // Nothing about that is visible in the interface. The text stays on screen, the footer says
    // live, and the work is gone on reload.
    //
    // Driven through a toolbar button rather than by typing: it is a real transaction on the real
    // editor, and it does not depend on ProseMirror's key handling under jsdom.
    const user = userEvent.setup();
    const doc = await open();

    await user.click(screen.getByRole('button', { name: 'Heading 1' }));

    await waitFor(() => {
      expect(doc.getXmlFragment('default').toArray().length).toBeGreaterThan(0);
    });
  });

  it('puts a block there, which is what the schema requires', async () => {
    // `doc` is `block+`. A fragment holding nothing converts to a document with no content, and
    // that is the shape the service refuses - so "not empty" is the claim and "holds a block" is
    // why it matters.
    const user = userEvent.setup();
    const doc = await open();

    await user.click(screen.getByRole('button', { name: 'Heading 1' }));

    await waitFor(() => {
      // `toJSON` rather than `toString`: an XmlFragment's default stringification is the object
      // tag, which would make this assertion pass on anything at all.
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain('heading');
    });
  });

  it('emits an update for a peer to receive', async () => {
    // No update means nothing is sent, however healthy the local editor looks.
    const user = userEvent.setup();
    const doc = await open();

    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });

    await user.click(screen.getByRole('button', { name: 'Heading 1' }));

    await waitFor(() => {
      expect(updates).toBeGreaterThan(0);
    });
  });
});

describe('the block drag handle', () => {
  // What jsdom can express ends at "the handle is wired in": the drag-handle plugin appends its
  // element into the editor's DOM when it registers, so the element's presence is the proof of
  // registration. Actually dragging a block needs real layout and HTML5 drag events, neither of
  // which jsdom implements - that behavior is exercised only in a real browser.

  /** Renders the editor and returns the handle element from within this render's own tree. */
  async function openWithHandle(): Promise<HTMLElement> {
    const { container } = render(<NoteEditor itemId="00000000-0000-4000-8000-000000000001" />);

    // `data-dragging` is set by the drag-handle plugin's own view setup, so finding it means the
    // plugin registered against this editor - not merely that some div rendered. Scoped to the
    // container so the assertion cannot be satisfied by anything outside this render.
    await waitFor(() => {
      expect(container.querySelector('[data-dragging]')).not.toBeNull();
    });
    const handle = container.querySelector<HTMLElement>('[data-dragging]');
    if (handle === null) {
      throw new Error('The drag-handle element never mounted.');
    }
    return handle;
  }

  it('mounts the handle element when the editor opens', async () => {
    await openWithHandle();
  });

  it('renders the grip glyph inside the handle, out of the accessibility tree', async () => {
    const handle = await openWithHandle();

    // The load-bearing assertion: the grip is in the DOM but hidden from assistive technology,
    // because a pointer-only affordance announced to a screen reader would be a control it
    // cannot operate. The wrapper itself is a role-less, name-less div, so nothing here reaches
    // the accessibility tree.
    const glyph = handle.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');

    // Plugin behavior, asserted more loosely: hidden at rest, shown on block hover; draggable,
    // which is the whole point of the element existing.
    expect(handle.style.visibility).toBe('hidden');
    expect(handle.draggable).toBe(true);
  });
});

describe('a change that would empty the document', () => {
  // ProseMirror cannot empty a document - `doc` is `block+`, so deleting everything leaves one
  // empty paragraph - but the Yjs layer underneath it can: the undo manager unwinds history
  // below ProseMirror's floor. The sync binding does heal an emptied fragment, but a render
  // cycle later - and in that gap collab-sync's flush timer can fire, or a teardown can flush,
  // and the emptying update goes to the server alone. The collaboration service refuses it as a
  // document it could never reopen and forces a resync, which on screen reads as an edit that
  // silently did not take. Observed in a dev log as `document_does_not_parse` with `fragment
  // held: nothing` against a note whose stored state was three healthy paragraphs.
  //
  // The emptying in these tests is done directly on the shared document rather than through the
  // interface, because that is the seam being guarded: whatever produced it upstream, a local
  // transaction with no children left is the event the editor must answer.

  /** Opens the editor, makes one edit, and returns the document and its content fragment. */
  async function openWithAHeading(): Promise<{
    user: ReturnType<typeof userEvent.setup>;
    doc: Y.Doc;
    fragment: Y.XmlFragment;
  }> {
    const user = userEvent.setup();
    const doc = await open();

    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    const fragment = doc.getXmlFragment('default');
    await waitFor(() => {
      expect(fragment.toArray().length).toBeGreaterThan(0);
    });

    return { user, doc, fragment };
  }

  it('restores one paragraph before the emptying can be sent', async () => {
    const { doc, fragment } = await openWithAHeading();

    doc.transact(() => {
      fragment.delete(0, fragment.length);
    });

    // Restored by the time the transaction returns, not merely eventually: collab-sync holds
    // every update behind its flush timer, so two updates queued in one tick always share a
    // flush - which is the property that keeps a send boundary from falling between the
    // emptying and the restoration. Exactly one paragraph, because the binding's own healing
    // runs afterwards and must not contribute a second.
    expect(fragment.toArray().length).toBe(1);
    expect(JSON.stringify(fragment.toJSON())).toContain('paragraph');

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(fragment.toArray().length).toBe(1);
  });

  it('leaves a remote emptying for the peer that produced it to answer', async () => {
    // A peer that empties the shared document is running this same guard, and both sides
    // answering would leave two paragraphs in the merged result. The refusal of unparseable
    // updates is the server's job; this editor speaks only for its own edits.
    const { doc, fragment } = await openWithAHeading();

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerFragment = peer.getXmlFragment('default');
    const before = Y.encodeStateVector(doc);
    peer.transact(() => {
      peerFragment.delete(0, peerFragment.length);
    });

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, before));

    expect(fragment.toArray().length).toBe(0);
    peer.destroy();
  });

  it('keeps the restored paragraph through a further undo', async () => {
    // The restoration is written under an origin the undo manager does not track, so unwinding
    // further cannot take the document back below the floor the restoration re-established.
    const { user, fragment } = await openWithAHeading();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(fragment.toArray().length).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(fragment.toArray().length).toBe(1);
      expect(JSON.stringify(fragment.toJSON())).toContain('paragraph');
    });
  });

  it('removes the placeholder again when a collaborator brings content back', async () => {
    // The cleanup cannot wait for this person's next edit: after an undo to blank, a colleague
    // still typing would otherwise share a document carrying a blank block nobody authored -
    // and if the undoer walks away, it stays. Removing on any origin is safe because the guard
    // only ever deletes the one element it created, and only while that element is empty.
    const { doc, fragment } = await openWithAHeading();

    doc.transact(() => {
      fragment.delete(0, fragment.length);
    });
    expect(fragment.toArray().length).toBe(1);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(doc);
    peer.transact(() => {
      peer.getXmlFragment('default').push([new Y.XmlElement('heading')]);
    });

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, before));

    await waitFor(() => {
      expect(fragment.toArray().length).toBe(1);
      expect(JSON.stringify(fragment.toJSON())).toContain('heading');
    });
    peer.destroy();
  });

  it('removes the placeholder again when redo brings the content back', async () => {
    // Without this, undo-then-redo would permanently add a blank block the person never
    // authored - and being untracked, no undo could ever remove it. The placeholder is the
    // guard's to manage only while it stays empty; the moment real content returns beside it,
    // it goes, and the document is exactly what the undo removed.
    const { user, fragment } = await openWithAHeading();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(fragment.toArray().length).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => {
      expect(fragment.toArray().length).toBe(1);
      expect(JSON.stringify(fragment.toJSON())).toContain('heading');
    });
  });
});
