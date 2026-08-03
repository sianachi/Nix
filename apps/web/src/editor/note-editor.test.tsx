import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';

import type * as collabSync from './collab-sync';
import { NoteEditor } from './note-editor';

/**
 * The provider is replaced, and the document it is handed is kept.
 *
 * `NoteEditor` builds its own `Y.Doc` with `useState`, so there is no way in from outside - and
 * that document is the whole subject. `startCollabSync` is the one place it is passed anywhere,
 * which makes the provider the natural seam: stub it, keep what it was given, and the test can ask
 * the real component's real document what is in it.
 */
let captured: Y.Doc | null = null;

vi.mock('./collab-sync', async () => {
  const actual = await vi.importActual<typeof collabSync>('./collab-sync');
  return {
    ...actual,
    startCollabSync: (options: { doc: Y.Doc }) => {
      captured = options.doc;
      return { awareness: null, destroy: () => undefined };
    },
  };
});

vi.mock('../auth/auth-provider', () => ({
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

describe('a note nobody has typed into yet', () => {
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
