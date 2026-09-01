import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { ApiClientProvider } from '../../api/api-client-provider';
import type * as collabSync from '../../editor/collab-sync';
import { useKeyboardModeStore } from '../../editor/keyboard-mode-store';
import { NoteEditor } from '../../editor/note-editor';
import { ApiClientProvider } from '../../api/api-client-provider';

/**
 * The provider is replaced, and the document it is handed is kept.
 *
 * `NoteEditor` builds its own `Y.Doc` with `useState`, so there is no way in from outside - and
 * that document is the whole subject. `startCollabSync` is the one place it is passed anywhere,
 * which makes the provider the natural seam: stub it, keep what it was given, and the test can ask
 * the real component's real document what is in it.
 */
let captured: Y.Doc | null = null;

const NAVIGATOR_PLATFORM: unknown = Reflect.get(navigator, 'platform');
const MODIFIER: KeyboardEventInit =
  typeof NAVIGATOR_PLATFORM === 'string' && /Mac|iP(hone|[oa]d)/.test(NAVIGATOR_PLATFORM)
    ? { metaKey: true }
    : { ctrlKey: true };

function pluginKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('key' in value)) {
    return null;
  }
  return typeof value.key === 'string' ? value.key : null;
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const result: unknown = Reflect.get(value, key);
  return result;
}

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

// BubbleMenu has its own real-editor suite. Its only extra work here would be measuring a text
// selection through `coordsAtPos`, a browser-layout API jsdom cannot implement.
vi.mock('../../editor/bubble-menu', () => ({ BubbleMenu: () => null }));

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
  useKeyboardModeStore.setState({ mode: 'standard', persistence: 'stored' });
});

/** Renders the editor and returns the shared document it handed the provider. */
async function open(): Promise<Y.Doc> {
  render(
    <ApiClientProvider>
      <NoteEditor itemId="00000000-0000-4000-8000-000000000001" />
    </ApiClientProvider>,
  );

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

  it('inserts an accessible image through the shared form', async () => {
    const user = userEvent.setup();
    const doc = await open();

    // Give the image a real insertion point. The collaboration fragment starts empty in this
    // harness until the first local transaction; production notes open with a schema-valid block.
    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Image address' }),
      'https://images.example.test/roadmap.png',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Description' }),
      'Product roadmap drawn as a timeline',
    );
    await user.click(screen.getByRole('button', { name: 'Insert image' }));

    await waitFor(() => {
      const body = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(body).toContain('https://images.example.test/roadmap.png');
      expect(body).toContain('Product roadmap drawn as a timeline');
      expect(body.match(/https:\/\/images\.example\.test\/roadmap\.png/g)).toHaveLength(1);
      expect(body).toContain('paragraph');
    });
    expect(screen.queryByRole('dialog', { name: 'Insert image' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Note body')).toHaveFocus();
    });
  });

  it('commits a submitted image before the deferred focus frame can be interrupted', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    const doc = await open();

    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Image address' }),
      'https://images.example.test/committed-before-focus.png',
    );
    await user.click(screen.getByRole('button', { name: 'Insert image' }));

    // The frame is deliberately never run. A tab change can unmount the editor at this exact
    // point, so a command queued beside focus would lose an already accepted submission.
    expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain(
      'https://images.example.test/committed-before-focus.png',
    );
    expect(screen.queryByRole('dialog', { name: 'Insert image' })).not.toBeInTheDocument();
  });

  it('leaves the document untouched and restores the image button when insertion is cancelled', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const imageButton = screen.getByRole('button', { name: 'Image' });
    const before = JSON.stringify(doc.getXmlFragment('default').toJSON());

    await user.click(imageButton);
    await user.type(
      screen.getByRole('textbox', { name: 'Image address' }),
      'https://images.example.test/unused.png',
    );
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(screen.queryByRole('dialog', { name: 'Insert image' })).not.toBeInTheDocument();
    expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toBe(before);
    expect(imageButton).toHaveFocus();
  });

  it('keeps a selected link anchored while a peer edits and writes the mark to the shared document', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const body = screen.getByLabelText('Note body');

    doc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Roadmap')]);
      doc.getXmlFragment('default').push([paragraph]);
    });
    await waitFor(() => {
      expect(body).toHaveTextContent('Roadmap');
    });
    body.focus();
    const text = body.querySelector('p')?.firstChild;
    if (text === null || text === undefined) {
      throw new Error('The shared paragraph did not render a text node.');
    }
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'Roadmap'.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await user.click(screen.getByRole('button', { name: 'Add link' }));

    // The modal preserves an editor selection while collaboration continues behind it. A peer
    // appending a block exercises the Yjs mapping boundary before the delayed command consumes
    // that selection; the link must stay on the local text rather than disappear or move.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const beforePeerEdit = Y.encodeStateVector(doc);
    peer.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Peer note')]);
      peer.getXmlFragment('default').push([paragraph]);
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, beforePeerEdit));

    await user.type(
      screen.getByRole('textbox', { name: 'Link address' }),
      'https://example.test/roadmap',
    );
    await user.click(
      within(screen.getByRole('dialog', { name: 'Add link' })).getByRole('button', {
        name: 'Add link',
      }),
    );

    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).toContain('Roadmap');
      expect(shared).toContain('Peer note');
      expect(shared).toContain('https://example.test/roadmap');
      expect(shared.match(/https:\/\/example\.test\/roadmap/g)).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog', { name: 'Add link' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(body).toHaveFocus();
    });
    peer.destroy();
  });
});

describe('collaborative history keys', () => {
  it.each([
    ['undo', 'z', false],
    ['shift redo', 'z', true],
    ['alternate redo', 'y', false],
  ])(
    'claims empty %s instead of falling through to browser contenteditable history',
    async (_name, key, shiftKey) => {
      await open();
      const body = screen.getByLabelText('Note body');
      const event = new KeyboardEvent('keydown', {
        key,
        ...MODIFIER,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });

      body.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    },
  );

  it('installs only collaborative history', async () => {
    await open();
    const body = screen.getByLabelText('Note body');
    const editor: unknown = Reflect.get(body, 'editor');
    const extensions = property(property(editor, 'extensionManager'), 'extensions');
    const plugins = property(property(editor, 'state'), 'plugins');
    if (!Array.isArray(extensions) || !Array.isArray(plugins)) {
      throw new Error('TipTap did not expose its editor state on the ProseMirror element.');
    }

    expect(extensions.some((extension) => property(extension, 'name') === 'undoRedo')).toBe(false);
    expect(plugins.some((plugin) => pluginKey(plugin)?.startsWith('history$') === true)).toBe(
      false,
    );
  });

  it('returns focus to the note after toolbar undo', async () => {
    const user = userEvent.setup();
    await open();
    const body = screen.getByLabelText('Note body');
    const undoButton = screen.getByRole('button', { name: 'Undo' });

    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await user.click(undoButton);

    await waitFor(() => {
      expect(body).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => {
      expect(body).toHaveFocus();
      expect(body.querySelector('h1')).not.toBeNull();
    });
  });

  it('keeps focus on an unavailable history action', async () => {
    const user = userEvent.setup();
    await open();
    const undoButton = screen.getByRole('button', { name: 'Undo' });

    await user.click(undoButton);

    expect(undoButton).toHaveFocus();
  });

  it('keeps redo available when a peer edits after this writer undoes', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const body = screen.getByLabelText('Note body');

    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain('heading');
    });

    useKeyboardModeStore.setState({ mode: 'emacs' });
    body.focus();
    fireEvent.keyDown(body, { key: '/', ctrlKey: true });
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).not.toContain('heading');
    });

    // The remote transaction deliberately lands between undo and redo. It must neither enter this
    // client's history nor clear the redo stack that belongs to the local heading change.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const beforePeerEdit = Y.encodeStateVector(peer);
    peer.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      peer.getXmlFragment('default').push([paragraph]);
      const text = new Y.XmlText();
      paragraph.push([text]);
      text.insert(0, 'Peer note');
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, beforePeerEdit));

    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).not.toContain('heading');
      expect(shared).toContain('Peer note');
    });

    fireEvent.keyDown(body, { key: 'z', ...MODIFIER, shiftKey: true });
    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).toContain('heading');
      expect(shared).toContain('Peer note');
    });

    fireEvent.keyDown(body, { key: '_', ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).not.toContain('heading');
      expect(shared).toContain('Peer note');
    });
    fireEvent.keyDown(body, { key: 'y', ...MODIFIER });
    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).toContain('heading');
      expect(shared).toContain('Peer note');
    });
    peer.destroy();
  });

  it('clears redo when this writer makes a new change after undo', async () => {
    const user = userEvent.setup();
    const doc = await open();
    const body = screen.getByLabelText('Note body');

    await user.click(screen.getByRole('button', { name: 'Heading 1' }));
    body.focus();
    fireEvent.keyDown(body, { key: 'z', ...MODIFIER });
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).not.toContain('heading');
    });

    await user.click(screen.getByRole('button', { name: 'Heading 2' }));
    await waitFor(() => {
      expect(body.querySelector('h2')).not.toBeNull();
    });

    fireEvent.keyDown(body, { key: 'z', ...MODIFIER, shiftKey: true });
    expect(body.querySelector('h2')).not.toBeNull();
    expect(body.querySelector('h1')).toBeNull();
  });
});

describe('Vim basics in a note', () => {
  it('shows and announces the pane-local mode while describing how to leave it', async () => {
    useKeyboardModeStore.setState({ mode: 'vim' });
    await open();
    const body = screen.getByLabelText('Note body');
    const descriptionId = body.getAttribute('aria-describedby');

    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId ?? '')).toHaveTextContent(/Press i.*Escape/i);
    expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);

    fireEvent.keyDown(body, { key: 'i' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim insert/i);
    });
    fireEvent.keyDown(body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);
    });
  });

  it('switches the same collaborative editor live and resets each Vim session to Normal', async () => {
    await open();
    const body = screen.getByLabelText('Note body');
    const editor: unknown = Reflect.get(body, 'editor');

    act(() => {
      useKeyboardModeStore.setState({ mode: 'vim' });
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);
    });
    fireEvent.keyDown(body, { key: 'i' });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim insert/i);
    });

    act(() => {
      useKeyboardModeStore.setState({ mode: 'standard' });
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => {
      useKeyboardModeStore.setState({ mode: 'vim' });
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);
    });

    expect(screen.getByLabelText('Note body')).toBe(body);
    expect(Reflect.get(body, 'editor')).toBe(editor);
  });

  it('keeps Normal inert and records Insert typing in local collaborative history', async () => {
    const user = userEvent.setup();
    useKeyboardModeStore.setState({ mode: 'vim' });
    const doc = await open();
    const body = screen.getByLabelText('Note body');
    body.focus();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Vim normal/i);
    });
    const beforeNormal = JSON.stringify(doc.getXmlFragment('default').toJSON());

    fireEvent.keyDown(body, { key: 'q' });
    body.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: 'blocked',
        bubbles: true,
        cancelable: true,
      }),
    );
    fireEvent.paste(body, {
      clipboardData: { getData: () => 'blocked', types: ['text/plain'] },
    });
    expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toBe(beforeNormal);

    fireEvent.keyDown(body, { key: 'i' });
    await user.keyboard('x');
    await waitFor(() => {
      expect(JSON.stringify(doc.getXmlFragment('default').toJSON())).toContain('x');
    });
    fireEvent.keyDown(body, { key: 'Escape' });

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const beforePeerEdit = Y.encodeStateVector(doc);
    peer.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Peer note')]);
      peer.getXmlFragment('default').push([paragraph]);
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, beforePeerEdit));

    fireEvent.keyDown(body, { key: 'z', ...MODIFIER });
    await waitFor(() => {
      const shared = JSON.stringify(doc.getXmlFragment('default').toJSON());
      expect(shared).not.toContain('x');
      expect(shared).toContain('Peer note');
    });
    peer.destroy();
  });

  it('lets an open slash menu consume Escape before Vim leaves Insert', async () => {
    const user = userEvent.setup();
    useKeyboardModeStore.setState({ mode: 'vim' });
    await open();
    const body = screen.getByLabelText('Note body');
    body.focus();
    fireEvent.keyDown(body, { key: 'i' });

    await user.keyboard('/');
    expect(await screen.findByRole('listbox')).toBeVisible();
    fireEvent.keyDown(body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/Vim insert/i);
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
    const { container } = render(
      <ApiClientProvider>
        <NoteEditor itemId="00000000-0000-4000-8000-000000000001" />
      </ApiClientProvider>,
    );

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

describe('a toggle in the real editor', () => {
  /**
   * `toggle-button.test.tsx` proves the two renderers behave; this proves this component is
   * the one that installs them. Without it, `note-editor.tsx` could drop either from its
   * extension list and every keyboard test there would still pass against a harness that
   * wires them by hand.
   *
   * The toggle arrives through the shared document rather than through the interface,
   * because that is the one seam this test has into the editor the component builds for
   * itself - and it is the same seam the collaboration service writes through in production.
   */
  it('draws the disclosure button and the heading semantics this app configures', async () => {
    const doc = await open();
    const fragment = doc.getXmlFragment('default');

    doc.transact(() => {
      const summary = new Y.XmlElement('detailsSummary');
      summary.insert(0, [new Y.XmlText('Plan')]);

      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Hidden body')]);
      const content = new Y.XmlElement('detailsContent');
      content.insert(0, [paragraph]);

      const details = new Y.XmlElement('details');
      details.setAttribute('toggleLevel', '2');
      details.insert(0, [summary, content]);

      fragment.insert(0, [details]);
    });

    // The disclosure control, named after its section with the state in `aria-expanded` -
    // `renderToggleButton`'s contract, reached only because this component passes it in.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });

    // And the summary's heading semantics, which come from the node view rather than from
    // any class: a toggle heading that is only a type step is a hierarchy no screen reader
    // can hear.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Plan');
  });
});
