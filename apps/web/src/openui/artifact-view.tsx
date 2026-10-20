import { items, type Item } from '@nix/api-client';
import { Button, Skeleton, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { fenced, fencedState, programIn, stateIn, storableState } from './fence';
import OpenUiBlock from './openui-block';
import { ProgramEditor } from './program-editor';

type Saved = ReturnType<typeof stateIn>;

type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'ready';
      readonly item: Item;
      readonly program: string | null;
      /** The values saved in the body, as stored. */
      readonly saved: Saved;
    };

/**
 * An artifact item drawn live: the first `openui-lang` program in its body, scoped to the
 * artifact's own workspace, starting from the values saved beside it in the same body (an
 * `openui-state` block), so everyone who opens it sees the same values and a lock covers them.
 * "Edit source" (`editable`) opens the program editor, which replaces only the program's passage
 * of the body; the values block is never touched. The pet changes it with its body-edit tools.
 */
export default function ArtifactView({
  itemId,
  editable = false,
}: {
  readonly itemId: string;
  /** Offers "Edit source", which saves through the same body-edit path as the saved values. */
  readonly editable?: boolean;
}): ReactNode {
  const client = useApiClient();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  // Changed values, kept here until the viewer chooses to share them (security fix M1).
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { createCompanionBodies } = await import('@nix/companion');
        const [item, body] = await Promise.all([
          client.query(items.itemById(itemId), { signal: controller.signal, forceRefresh: true }),
          createCompanionBodies(client).read(itemId, controller.signal),
        ]);
        const markdown = (body as { markdown?: unknown }).markdown;
        const text = typeof markdown === 'string' ? markdown : '';
        if (!controller.signal.aborted)
          setLoaded({ status: 'ready', item, program: programIn(text), saved: stateIn(text) });
      } catch {
        if (!controller.signal.aborted) setLoaded({ status: 'failed' });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [client, itemId, editing]);

  /**
   * Values change on every click and keystroke, but they are shared with everyone who opens the
   * artifact, so they are saved only when the viewer says so, after seeing exactly what will be
   * stored. Saving on every change would let a program copy what this viewer can read (a query
   * result, through `@Set`) into a property other members read, without anyone deciding to.
   */
  function changed(state: Record<string, unknown>) {
    const text = storableState(state);
    if (text === null) {
      setNotice('These values are too large to keep; they last until you leave.');
      return;
    }
    setNotice('');
    setUnsaved(text);
  }

  async function share(text: string) {
    if (loaded.status !== 'ready') return;
    setSaving(true);
    try {
      const { createCompanionBodies } = await import('@nix/companion');
      const bodies = createCompanionBodies(client);
      const signal = new AbortController().signal;
      // shortcut: the last save wins when two people save the same artifact at once; merge per
      // $variable if shared artifacts start to see concurrent use.
      if (loaded.saved === null) await bodies.append(itemId, fencedState(text), signal);
      else {
        // The saved values are the whole text of their own code block, so a passage edit
        // replaces exactly them, planned and applied against the body as it is now.
        const edit = { kind: 'passage' as const, find: loaded.saved.text, replace: text };
        const plan = await bodies.planEdit(itemId, edit, signal);
        await bodies.applyEdit(itemId, edit, plan.fingerprint, signal);
      }
      setLoaded({ ...loaded, saved: stateIn(fencedState(text)) });
      setUnsaved(null);
    } catch {
      setNotice("These values can't be saved here: you can use this artifact but not edit it.");
    } finally {
      setSaving(false);
    }
  }

  async function saveProgram(program: string) {
    if (loaded.status !== 'ready') return;
    setSaving(true);
    try {
      const { createCompanionBodies } = await import('@nix/companion');
      const bodies = createCompanionBodies(client);
      const signal = new AbortController().signal;
      if (loaded.program === null) await bodies.append(itemId, fenced(program), signal);
      else {
        // The program is the whole text of its own code block, so a passage edit replaces exactly
        // it; the values block and everything else in the body stay as they are.
        const edit = {
          kind: 'passage' as const,
          find: loaded.program,
          replace: `${program.trimEnd()}\n`,
        };
        const plan = await bodies.planEdit(itemId, edit, signal);
        await bodies.applyEdit(itemId, edit, plan.fingerprint, signal);
      }
      setNotice('');
      setEditing(false);
    } catch {
      setNotice("This program can't be saved here: you can use this artifact but not edit it.");
    } finally {
      setSaving(false);
    }
  }

  const toggle = editable ? (
    <div>
      <Button
        variant="ghost"
        onClick={() => {
          if (!editing && loaded.status === 'ready') setDraft(loaded.program ?? '');
          setNotice('');
          setEditing(!editing);
        }}
      >
        {editing ? 'Cancel' : 'Edit source'}
      </Button>
    </div>
  ) : null;

  if (loaded.status === 'loading')
    return (
      <div className="p-4">
        <span role="status" className="sr-only">
          Loading the artifact…
        </span>
        <Skeleton shape="block" />
      </div>
    );
  if (loaded.status === 'failed')
    return (
      <Text role="alert" className="p-4">
        This artifact could not be loaded.
      </Text>
    );
  if (editing)
    return (
      <div className="flex min-w-0 flex-col gap-2 p-4">
        <ProgramEditor
          value={draft}
          onChange={setDraft}
          workspaceId={loaded.item.workspaceId}
          label="Program"
        />
        {notice ? (
          <Text variant="note" role="alert">
            {notice}
          </Text>
        ) : null}
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={saving || draft.trim() === ''}
            onClick={() => {
              void saveProgram(draft);
            }}
          >
            Save source
          </Button>
          {toggle}
        </div>
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      {toggle}
      {loaded.program === null ? (
        <Text variant="note">
          This artifact has no openui-lang program yet. Use Edit source to add one.
        </Text>
      ) : (
        <OpenUiBlock
          key={loaded.item.id}
          source={loaded.program}
          workspaceIds={[loaded.item.workspaceId]}
          fallback={
            <Text variant="note" role="alert">
              This artifact's program does not render. Use Edit source to fix it.
            </Text>
          }
          initialState={loaded.saved?.values}
          onStateChange={changed}
        />
      )}
      {unsaved !== null ? (
        <div className="flex flex-col gap-2">
          <details>
            <summary>
              <Text as="span" variant="note">
                What will be saved
              </Text>
            </summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-sm border border-divider p-2">
              <Text as="span" variant="note" className="font-mono">
                {unsaved}
              </Text>
            </pre>
          </details>
          <div>
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => {
                void share(unsaved);
              }}
            >
              Save values for everyone
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <Text variant="note" role="status">
          {notice}
        </Text>
      ) : null}
    </div>
  );
}
