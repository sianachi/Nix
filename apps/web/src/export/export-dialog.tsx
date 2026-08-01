import { Button, Dialog, Segmented, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PartialNotice } from '../components/states/status-panels';
import { requestArchive, saveArchive, type ArchiveScope } from './export-archive';

/**
 * Exporting an item as a `.nix` archive.
 *
 * **The scope is asked rather than assumed.** "This item" and "everything inside it" are different
 * files and there is no default that is right for both - somebody exporting a note wants the note,
 * and somebody exporting a project wants the project.
 *
 * **The result is reported, not implied.** A download starting is evidence that something happened
 * and no evidence at all of what is in it, so an export that left items out says so and stays open
 * to say it. An export that left nothing out closes, because a dialog reporting complete success is
 * a dialog somebody has to dismiss to get on with their work.
 */

const SCOPES: readonly { value: ArchiveScope; label: string }[] = [
  { value: 'item', label: 'This item' },
  { value: 'subtree', label: 'With everything inside' },
];

type Progress =
  | { readonly phase: 'idle' }
  | { readonly phase: 'working' }
  | { readonly phase: 'failed'; readonly error: string }
  | { readonly phase: 'partial'; readonly itemCount: number; readonly omittedCount: number };

export interface ExportDialogProps {
  readonly open: boolean;
  readonly itemId: string;
  readonly hasChildren: boolean;
  readonly getAccessToken: () => Promise<string | null>;
  readonly onClose: () => void;
}

export function ExportDialog({
  open,
  itemId,
  hasChildren,
  getAccessToken,
  onClose,
}: ExportDialogProps): ReactNode {
  // An item with nothing inside it has one honest answer, so it is not asked a question with one
  // real option.
  const [scope, setScope] = useState<ArchiveScope>(hasChildren ? 'subtree' : 'item');
  const [progress, setProgress] = useState<Progress>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      // A request outliving the dialog would resolve into a component nobody is looking at and, on
      // success, start a download the person had already walked away from.
      abort.current?.abort();
    },
    [],
  );

  async function run(): Promise<void> {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setProgress({ phase: 'working' });

    const outcome = await requestArchive({
      itemId,
      scope,
      getAccessToken,
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      return;
    }

    if (!outcome.ok) {
      setProgress({ phase: 'failed', error: outcome.error });
      return;
    }

    saveArchive(outcome.value);

    if (outcome.value.omittedCount === 0) {
      setProgress({ phase: 'idle' });
      onClose();
      return;
    }

    setProgress({
      phase: 'partial',
      itemCount: outcome.value.itemCount,
      omittedCount: outcome.value.omittedCount,
    });
  }

  const working = progress.phase === 'working';

  return (
    <Dialog
      open={open}
      title="Export"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {progress.phase === 'partial' ? 'Done' : 'Cancel'}
          </Button>
          <Button
            onClick={() => {
              void run();
            }}
            disabled={working}
          >
            {working ? 'Preparing…' : 'Export'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Text tone="muted" variant="body">
          A <code>.nix</code> archive keeps everything: the text, the properties, the fields and
          views, and the order things are in. It is the format that can be brought back without
          losing anything.
        </Text>

        {hasChildren ? (
          <Segmented label="What to export" options={SCOPES} value={scope} onChange={setScope} />
        ) : null}

        {progress.phase === 'failed' ? (
          // The role goes on the wrapper because `<Text>` is deliberately presentational - it takes
          // a variant and a tone, not arbitrary attributes, so that type decisions cannot be
          // smuggled past it.
          <div role="alert">
            <Text tone="muted">{progress.error}</Text>
          </div>
        ) : null}

        {progress.phase === 'partial' ? (
          <PartialNotice
            pending={`${String(progress.itemCount)} ${progress.itemCount === 1 ? 'item was' : 'items were'} exported. ${String(progress.omittedCount)} ${progress.omittedCount === 1 ? 'was' : 'were'} left out, because ${progress.omittedCount === 1 ? 'it is' : 'they are'} deleted, not yours to read, or past the size one export carries. The archive's manifest names each one.`}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
