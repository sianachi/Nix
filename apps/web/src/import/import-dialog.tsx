import { Button, Dialog, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { ErrorPanel, PartialNotice } from '../components/states/status-panels';
import {
  planImport,
  screenPaths,
  type ImportPlan,
  type PathReason,
  type PlannedNode,
} from './import-plan';
import { runImportPlan, undoImport, type ImportRunReport } from './import-run';

/**
 * Importing Markdown into the workspace: preview first, then commit, then an honest report.
 *
 * **The preview is shown before anything is created**, because a mapping is a set of decisions -
 * which files become notes, which are skipped and why, what front matter turns into properties,
 * which links cannot be resolved - and the person should read them while there is still nothing to
 * regret. This is 7.5's order: preview, report, undo.
 *
 * **Only the chosen files worth reading are read.** A folder pick delivers everything the folder
 * holds, so the selection is screened by path first (`screenPaths`) and attachments, images and a
 * tool's hidden directories are turned away before a byte of them is loaded - a large vault must
 * not cost its own size in memory to be previewed.
 *
 * **A run in progress can always be stopped.** The trailing button becomes "Stop import" and the
 * dialog's close control stops rather than closes; what was created stays, the rest is reported
 * as not attempted, and the report renders as it would for any other partial run.
 *
 * **The report never rounds up.** A created item whose body write was refused is listed as
 * created, with the refusal beside it; an item the run never reached is listed as not attempted
 * with its reason. A partial import is said to be partial, in the service's own words where it
 * gave them.
 *
 * Only the Markdown lane exists today: `.nix`, DOCX and PDF import need the server endpoint MVP-7
 * still owes, and the picker says so rather than accepting what it cannot map.
 */

type Phase =
  | { readonly name: 'pick'; readonly reading: boolean; readonly error: string | null }
  | { readonly name: 'preview'; readonly plan: ImportPlan }
  | { readonly name: 'working'; readonly done: number; readonly total: number }
  | {
      readonly name: 'report';
      readonly report: ImportRunReport;
      readonly undo: UndoState;
      /** Kept so a run that could not start can be retried without re-picking. */
      readonly plan: ImportPlan;
    };

type UndoState =
  | { readonly name: 'available' }
  | { readonly name: 'working' }
  | { readonly name: 'done' }
  | { readonly name: 'failed'; readonly error: string };

/** Some browsers have no folder picker; offering the button there would silently pick files. */
const FOLDER_PICK_SUPPORTED =
  typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;

export interface ImportDialogProps {
  readonly open: boolean;
  /** The item the import goes under; the workspace root when null. */
  readonly parentId: string | null;
  readonly getAccessToken: () => Promise<string | null>;
  readonly onClose: () => void;
  /** Called once when a run has created its root, so the shell can reveal it in the tree. */
  readonly onImported?: (rootItemId: string) => void;
}

export function ImportDialog({
  open,
  parentId,
  getAccessToken,
  onClose,
  onImported,
}: ImportDialogProps): ReactNode {
  const client = useApiClient();
  const [phase, setPhase] = useState<Phase>({ name: 'pick', reading: false, error: null });
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      // Unmounting the whole screen mid-run: stop between items so what was created stays and
      // nothing more is made for a report nobody will see.
      abort.current?.abort();
    },
    [],
  );

  async function chose(list: FileList | null): Promise<void> {
    if (list === null || list.length === 0) {
      return;
    }
    const files = [...list];
    setPhase({ name: 'pick', reading: true, error: null });

    try {
      // Screen by path before reading: a folder pick includes attachments, images and hidden
      // tool directories, and reading those just to skip them is how a big vault crashes the tab.
      const paths = files.map(pathOf);
      const screened = screenPaths(paths);
      const wanted = files.filter((_, index) => screened.wanted[index] === true);

      if (wanted.length === 0) {
        setPhase({
          name: 'pick',
          reading: false,
          error: `Nothing importable was chosen: ${distinctReasons(screened.skipped)}.`,
        });
        return;
      }

      // The parser subpath, not the package root, so the lazy chunk carries only the inbound
      // direction. Loaded in parallel with the file reads.
      const [{ markdownToDocument }, sources] = await Promise.all([
        import('@nix/markdown/from-markdown'),
        Promise.all(wanted.map(async (file) => ({ path: pathOf(file), text: await file.text() }))),
      ]);

      const plan = planImport(sources, markdownToDocument, undefined, screened.skipped);
      if (plan.root === null) {
        setPhase({
          name: 'pick',
          reading: false,
          error:
            plan.failed.length > 0
              ? `The chosen files could not become notes: ${distinctReasons(plan.failed)}.`
              : `Nothing importable was chosen: ${distinctReasons(plan.skipped)}.`,
        });
        return;
      }
      setPhase({ name: 'preview', plan });
    } catch {
      setPhase({
        name: 'pick',
        reading: false,
        error: 'The files could not be read. Choose them again.',
      });
    }
  }

  async function run(plan: ImportPlan): Promise<void> {
    if (plan.root === null) {
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setPhase({ name: 'working', done: 0, total: plan.totalItems });
    try {
      const report = await runImportPlan({
        plan: plan.root,
        parentId,
        client,
        getAccessToken,
        signal: controller.signal,
        onProgress: (done, total) => {
          setPhase({ name: 'working', done, total });
        },
      });

      if (report.rootItemId !== null) {
        onImported?.(report.rootItemId);
      }
      setPhase({ name: 'report', report, undo: { name: 'available' }, plan });
    } catch (cause) {
      // The run loop is written not to throw; this is insurance against the bug that proves it
      // wrong, and it must not strand the dialog in `working` with no exit.
      console.error('Import run failed unexpectedly:', cause);
      setPhase({
        name: 'pick',
        reading: false,
        error:
          'The import failed unexpectedly. Some items may already have been created - check the tree, then try again.',
      });
    }
  }

  function stop(): void {
    abort.current?.abort();
  }

  async function undo(current: Extract<Phase, { name: 'report' }>): Promise<void> {
    if (current.report.rootItemId === null) {
      return;
    }
    setPhase({ ...current, undo: { name: 'working' } });
    const outcome = await undoImport(client, current.report.rootItemId);
    setPhase({
      ...current,
      undo: outcome.ok
        ? { name: 'done' }
        : { name: 'failed', error: outcome.error ?? 'The undo was refused.' },
    });
  }

  const working = phase.name === 'working';

  return (
    <Dialog
      open={open}
      title="Import"
      // While a run is in flight, every way out - Escape, the backdrop, the X - stops the run
      // rather than abandoning it; the report then says what was made and what was not.
      onClose={working ? stop : onClose}
      actions={
        working ? (
          <Button variant="secondary" onClick={stop}>
            Stop import
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {phase.name === 'report' ? 'Done' : 'Cancel'}
            </Button>
            {phase.name === 'preview' ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPhase({ name: 'pick', reading: false, error: null });
                  }}
                >
                  Choose different files
                </Button>
                <Button
                  onClick={() => {
                    void run(phase.plan);
                  }}
                >
                  Import {String(phase.plan.totalItems)}{' '}
                  {phase.plan.totalItems === 1 ? 'item' : 'items'}
                </Button>
              </>
            ) : null}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {/* One live region for the dialog's whole life, mounted before any of its texts, so phase
            changes are actually announced - a region inserted together with its text is the
            canonical reason one never speaks (see a11y/announcer.ts). Deliberately coarse: phases,
            not per-item progress. */}
        <div role="status" className="sr-only">
          {liveText(phase)}
        </div>

        {phase.name === 'pick' ? (
          <>
            <Text tone="muted" variant="body">
              Choose an Obsidian vault or any folder of Markdown notes. Nix scans every nested
              folder and recreates that structure under one new item. Front matter is kept as item
              properties; each appears once a property of that name is declared on the item&rsquo;s
              schema.
            </Text>
            <Text tone="muted" variant="note">
              The .obsidian settings folder and non-Markdown attachments are skipped and named in
              the preview. Archives, Word and PDF cannot be imported yet.
            </Text>
            <div className="flex flex-wrap gap-2">
              {/* Out of the tab order and the a11y tree: the visible buttons are the controls, and
                  a focusable but invisible input is a focus ring nobody can see. */}
              <input
                ref={fileInput}
                type="file"
                accept=".md"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                aria-label="Markdown files to import"
                onChange={(event) => {
                  const files = event.currentTarget.files;
                  event.currentTarget.value = '';
                  void chose(files);
                }}
              />
              <input
                ref={folderInput}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                aria-label="Folder to import"
                {...{ webkitdirectory: '' }}
                onChange={(event) => {
                  const files = event.currentTarget.files;
                  event.currentTarget.value = '';
                  void chose(files);
                }}
              />
              {FOLDER_PICK_SUPPORTED ? (
                <Button
                  disabled={phase.reading}
                  onClick={() => {
                    folderInput.current?.click();
                  }}
                >
                  Choose a vault or folder
                </Button>
              ) : null}
              <Button
                variant="secondary"
                disabled={phase.reading}
                onClick={() => {
                  fileInput.current?.click();
                }}
              >
                Choose files
              </Button>
            </div>
            {FOLDER_PICK_SUPPORTED ? null : (
              <Text tone="muted" variant="note">
                This browser cannot select folders. You can still choose Markdown files.
              </Text>
            )}
            {phase.reading ? <Text tone="muted">Reading the files…</Text> : null}
            {phase.error !== null ? (
              <div role="alert">
                <Text tone="muted">{phase.error}</Text>
              </div>
            ) : null}
          </>
        ) : null}

        {phase.name === 'preview' ? <Preview plan={phase.plan} /> : null}

        {phase.name === 'working' ? (
          <Text tone="muted">
            Importing… {String(phase.done)} of {String(phase.total)} items.
          </Text>
        ) : null}

        {phase.name === 'report' ? (
          <Report
            report={phase.report}
            undo={phase.undo}
            onUndo={() => {
              void undo(phase);
            }}
            onRetry={
              phase.report.couldNotStart === undefined
                ? undefined
                : () => {
                    void run(phase.plan);
                  }
            }
          />
        ) : null}
      </div>
    </Dialog>
  );
}

/** What the single live region says; coarse on purpose - phases, never per-item counts. */
function liveText(phase: Phase): string {
  switch (phase.name) {
    case 'pick':
      return phase.reading ? 'Reading the chosen files.' : '';
    case 'preview':
      return `Preview ready: ${String(phase.plan.totalItems)} items to import.`;
    case 'working':
      return `Importing ${String(phase.total)} items.`;
    case 'report':
      return reportHeadline(phase.report);
  }
}

function reportHeadline(report: ImportRunReport): string {
  if (report.couldNotStart !== undefined) {
    return 'The import could not start.';
  }
  if (report.created.length === 0) {
    return 'Nothing was imported.';
  }
  const whole =
    report.failed.length === 0 &&
    report.notAttempted.length === 0 &&
    !report.stoppedEarly &&
    !report.created.some((row) => row.bodyError !== undefined || row.propertiesError !== undefined);
  const count = `${String(report.created.length)} ${report.created.length === 1 ? 'item was' : 'items were'} created`;
  return whole ? `${count}.` : `${count}, but not everything made it across.`;
}

/** Moves focus to the phase's first line, so the place lost with the pressed button is replaced. */
function FocusOnMount({ children }: { readonly children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div tabIndex={-1} ref={ref}>
      {children}
    </div>
  );
}

function Preview({ plan }: { readonly plan: ImportPlan }): ReactNode {
  const root = plan.root;
  if (root === null) {
    return null;
  }
  const notes = plan.totalItems - containers(root);
  const dropped = sumBy(root, (node) => node.droppedFrontMatter.length);
  const wiki = sumBy(root, (node) => node.unresolvedWikiLinks);
  const images = sumBy(root, (node) => node.unresolvedLocalImages);

  return (
    <>
      <FocusOnMount>
        <Text variant="body">
          {String(notes)} {notes === 1 ? 'note' : 'notes'} from the chosen files will be created
          under a new item called &ldquo;{root.title}&rdquo; - {String(plan.totalItems)} items in
          all, counting folders. Nothing is created until you press Import.
        </Text>
      </FocusOnMount>
      {groupByReason(plan.skipped).map((group) => (
        <PartialNotice
          key={`skip-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'file' : 'files'} will be skipped - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {groupByReason(plan.failed).map((group) => (
        <PartialNotice
          key={`fail-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'file' : 'files'} cannot become notes - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {wiki + images + dropped > 0 ? (
        <PartialNotice
          pending={`Carried but not resolved: ${String(wiki)} wiki ${wiki === 1 ? 'link' : 'links'} kept as text, ${String(images)} local image ${images === 1 ? 'reference' : 'references'}, ${String(dropped)} front matter ${dropped === 1 ? 'line' : 'lines'} dropped.`}
        />
      ) : null}
    </>
  );
}

function Report({
  report,
  undo,
  onUndo,
  onRetry,
}: {
  readonly report: ImportRunReport;
  readonly undo: UndoState;
  readonly onUndo: () => void;
  readonly onRetry?: (() => void) | undefined;
}): ReactNode {
  if (report.couldNotStart !== undefined) {
    return (
      <ErrorPanel
        title="The import could not start"
        detail={report.couldNotStart}
        action={
          onRetry === undefined ? undefined : (
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    );
  }

  if (report.created.length === 0) {
    // A run that made nothing is a refusal, not a partial: an alert, not a status beside content
    // that does not exist.
    return (
      <ErrorPanel
        title="Nothing was imported"
        detail={
          report.failed.length > 0
            ? `${withoutDot(distinctReasons(report.failed))}.`
            : (report.stopReason ??
              'The run made nothing and gave no reason - which is a bug worth reporting.')
        }
      />
    );
  }

  const lossy = report.created.filter(
    (row) => row.bodyError !== undefined || row.propertiesError !== undefined,
  );

  return (
    <>
      <FocusOnMount>
        <Text variant="body">{reportHeadline(report)}</Text>
      </FocusOnMount>
      {report.stopReason !== undefined ? (
        <PartialNotice pending={`${withoutDot(report.stopReason)}.`} />
      ) : null}
      {lossy.length > 0 ? (
        <PartialNotice
          pending={`${String(lossy.length)} created ${lossy.length === 1 ? 'item' : 'items'} lost part of ${lossy.length === 1 ? 'its' : 'their'} content: ${lossy
            .map(
              (row) => `${row.title} (${withoutDot(row.bodyError ?? row.propertiesError ?? '')})`,
            )
            .join('; ')}.`}
        />
      ) : null}
      {groupByReason(report.failed).map((group) => (
        <PartialNotice
          key={`fail-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'item' : 'items'} failed - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {groupByReason(report.notAttempted).map((group) => (
        <PartialNotice
          key={`skip-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'item was' : 'items were'} not attempted - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {report.rootItemId !== null ? (
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onUndo} disabled={undo.name !== 'available'}>
            {undo.name === 'working' ? 'Undoing…' : undo.name === 'done' ? 'Undone' : 'Undo import'}
          </Button>
          {undo.name === 'done' ? (
            <Text tone="muted" variant="note" as="span">
              The imported items were moved to deleted; they can be restored.
            </Text>
          ) : null}
          {undo.name === 'failed' ? (
            <div role="alert">
              <Text tone="muted" variant="note" as="span">
                {undo.error}
              </Text>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function pathOf(file: File): string {
  // Optional in fact, not just in type: only a folder pick fills it, and test doubles of File do
  // not carry it at all.
  return typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0
    ? file.webkitRelativePath
    : file.name;
}

interface ReasonGroup {
  readonly reason: string;
  readonly paths: readonly string[];
}

/** One group per distinct reason, each keeping the paths it covers - never a bare count. */
function groupByReason(rows: readonly PathReason[]): readonly ReasonGroup[] {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const paths = groups.get(row.reason);
    if (paths === undefined) {
      groups.set(row.reason, [row.path]);
    } else {
      paths.push(row.path);
    }
  }
  return [...groups.entries()].map(([reason, paths]) => ({ reason, paths }));
}

/** The first few paths by name, then an honest count of the rest. */
function pathsClause(paths: readonly string[]): string {
  const shown = paths.slice(0, 5);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${String(rest)} more` : shown.join(', ');
}

/** The distinct reasons, joined; used where paths would drown the sentence. */
function distinctReasons(rows: readonly PathReason[]): string {
  return [...new Set(rows.map((row) => withoutDot(row.reason)))].join('; ');
}

/** Reasons arrive both as fragments and as full sentences; strip the dot so ours is the only one. */
function withoutDot(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

function containers(node: PlannedNode): number {
  let total = node.kind === 'container' ? 1 : 0;
  for (const child of node.children) {
    total += containers(child);
  }
  return total;
}

function sumBy(node: PlannedNode, read: (entry: PlannedNode) => number): number {
  let total = read(node);
  for (const child of node.children) {
    total += sumBy(child, read);
  }
  return total;
}
