import { Button, Dialog, Text } from '@nix/ui';
import { imports as importResources, isNixApiError } from '@nix/api-client';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { useSessionStore } from '../auth/session-store';
import { useWorkspace } from '../workspaces/workspace-context';
import {
  distinctReasons,
  documentFormat,
  documentMediaType,
  pathOf,
  withoutExtension,
} from './import-format';
import { recordInterruptedImport } from './import-interrupted-notice';
import { liveText } from './import-live-text';
import type { Phase } from './import-phase';
import { PickStep } from './import-pick';
import { planImport, screenPaths, type ImportPlan } from './import-plan';
import { DocumentPreview, Preview } from './import-preview';
import { DocumentReport, Report } from './import-report';
import { runImportPlan, undoImport } from './import-run';

/**
 * Importing Markdown into the workspace: preview first, then commit, then an honest report.
 *
 * **The preview is shown before anything is created**, because a mapping is a set of decisions -
 * which files become notes, which are skipped and why, what front matter turns into properties,
 * which links cannot be resolved - and the person should read them while there is still nothing to
 * regret. This is 7.5's order: preview, report, undo.
 *
 * **Only Markdown is read for the preview.** A folder pick delivers everything it holds, so the
 * selection is screened by path first (`screenPaths`); attachments stay opaque browser files until
 * upload and hidden tool directories are turned away before a byte is loaded.
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
 * PDF, DOCX and TXT use the bounded document worker before entering the same preview and write
 * path. Their source bytes and extracted images are retained as child file items after the note.
 */

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
  const { workspaceId } = useWorkspace();
  const [phase, setPhase] = useState<Phase>({ name: 'pick', reading: false, error: null });
  const abort = useRef<AbortController | null>(null);
  const activeDocumentImport = useRef<string | null>(null);

  // Read in the unmount cleanup below, which otherwise closes over the render that scheduled the
  // effect - refs kept current by their own effect are how that cleanup sees the phase and
  // workspace that were actually on screen when the dialog went away, not stale ones.
  const subject = useSessionStore((state) => state.profile?.subject ?? null);
  const phaseRef = useRef(phase);
  const workspaceIdRef = useRef(workspaceId);
  const subjectRef = useRef(subject);
  useEffect(() => {
    phaseRef.current = phase;
    workspaceIdRef.current = workspaceId;
    // Only ever overwritten with a real subject: an expiring session clears the profile before
    // this dialog unmounts, and the notice must still name the person whose import it was.
    if (subject !== null) {
      subjectRef.current = subject;
    }
  }, [phase, workspaceId, subject]);

  useEffect(
    () => () => {
      // Unmounting the whole screen mid-run: stop between items so what was created stays and
      // nothing more is made for a report nobody will see.
      abort.current?.abort();

      // A run that was still in progress when this unmount happened was never closed through the
      // dialog's own controls - "Stop import" keeps the dialog mounted long enough to show its
      // report, and the close/cancel buttons are disabled while working. So this branch is
      // specifically the screen being torn down out from under an in-progress import - a session
      // expiring mid-task chief among them - not a person choosing to leave. What was already
      // created stays in the workspace with no report and no undo offered, so a short, content-free
      // summary is left for the workspace to show once the person is back in it.
      const current = phaseRef.current;
      if (current.name === 'working' && current.done > 0 && subjectRef.current !== null) {
        recordInterruptedImport({
          subject: subjectRef.current,
          workspaceId: workspaceIdRef.current,
          createdCount: current.done,
          totalCount: current.total,
        });
      }
    },
    [],
  );

  async function chose(files: readonly File[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    setPhase({ name: 'pick', reading: true, error: null });

    try {
      const document = files.length === 1 ? documentFormat(files[0]?.name ?? '') : null;
      if (document !== null && files[0] !== undefined) {
        const file = files[0];
        abort.current?.abort();
        const controller = new AbortController();
        abort.current = controller;
        const preview = await importResources.beginAndPreviewDocument(
          client,
          {
            workspaceId,
            parentId,
            format: document,
            title: withoutExtension(file.name),
            fileName: file.name,
            mediaType: documentMediaType(document, file.type),
            byteLength: file.size,
            idempotencyKey: `web-document:${crypto.randomUUID()}`,
          },
          file,
          controller.signal,
          (importId) => {
            activeDocumentImport.current = importId;
          },
        );
        setPhase({
          name: 'document-preview',
          operation: preview.operation,
          plan: preview.plan,
        });
        return;
      }
      // Screen by path before reading. Attachments stay as browser files until upload; only
      // Markdown is read for planning, so a large vault does not cost its attachment bytes twice.
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
      // direction. Loaded in parallel with Markdown file reads.
      const [{ markdownToDocument }, sources] = await Promise.all([
        import('@nix/markdown/from-markdown'),
        Promise.all(
          wanted.map(async (file) =>
            file.name.toLowerCase().endsWith('.md')
              ? { path: pathOf(file), text: await file.text() }
              : { path: pathOf(file), file },
          ),
        ),
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
      setPhase({ name: 'preview', plan, losses: [] });
    } catch (reason) {
      setPhase({
        name: 'pick',
        reading: false,
        error: isNixApiError(reason)
          ? (reason.detail ?? 'The document could not be converted.')
          : reason instanceof Error
            ? reason.message
            : 'The files could not be read. Choose them again.',
      });
    }
  }

  async function run(plan: ImportPlan, losses: readonly string[] = []): Promise<void> {
    if (plan.root === null) {
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setPhase({ name: 'working', done: 0, total: plan.totalItems });
    try {
      const report = await runImportPlan({
        workspaceId,
        plan: plan.root,
        parentId,
        client,
        getAccessToken,
        signal: controller.signal,
        onProgress: (done, total) => {
          setPhase({ name: 'working', done, total });
        },
      });

      if (report.rootItemId !== null) onImported?.(report.rootItemId);
      setPhase({ name: 'report', report, undo: { name: 'available' }, plan, losses });
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

  async function runDocument(current: Extract<Phase, { name: 'document-preview' }>): Promise<void> {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    activeDocumentImport.current = current.operation.id;
    setPhase({
      name: 'document-working',
      importId: current.operation.id,
      total: current.operation.itemCount ?? current.plan.items.length,
    });
    try {
      const completed = await importResources.commitAndWaitDocumentImport(
        client,
        current.operation.id,
        controller.signal,
      );
      activeDocumentImport.current = null;
      if (completed.rootItemId !== null) onImported?.(completed.rootItemId);
      setPhase({
        name: 'document-report',
        operation: completed,
        plan: current.plan,
        undo: { name: 'available' },
      });
    } catch (reason) {
      if (controller.signal.aborted) {
        setPhase({ name: 'pick', reading: false, error: 'The document import was cancelled.' });
        return;
      }
      activeDocumentImport.current = null;
      setPhase({
        name: 'pick',
        reading: false,
        error: isNixApiError(reason)
          ? (reason.detail ?? 'The document import was refused.')
          : reason instanceof Error
            ? reason.message
            : 'The document import was refused.',
      });
    }
  }

  function stop(): void {
    abort.current?.abort();
    const importId = activeDocumentImport.current;
    activeDocumentImport.current = null;
    if (importId !== null) void client.execute(importResources.cancelDocumentImport(importId));
  }

  function discardDocument(importId: string): void {
    activeDocumentImport.current = null;
    void client.execute(importResources.cancelDocumentImport(importId)).catch(() => undefined);
  }

  async function undo(current: Extract<Phase, { name: 'report' }>): Promise<void> {
    if (current.report.rootItemId === null) {
      return;
    }
    setPhase({ ...current, undo: { name: 'working' } });
    const outcome = await undoImport(client, workspaceId, current.report.rootItemId);
    setPhase({
      ...current,
      undo: outcome.ok
        ? { name: 'done' }
        : { name: 'failed', error: outcome.error ?? 'The undo was refused.' },
    });
  }

  async function undoDocument(current: Extract<Phase, { name: 'document-report' }>): Promise<void> {
    if (current.operation.rootItemId === null) return;
    setPhase({ ...current, undo: { name: 'working' } });
    const outcome = await undoImport(client, workspaceId, current.operation.rootItemId);
    setPhase({
      ...current,
      undo: outcome.ok
        ? { name: 'done' }
        : { name: 'failed', error: outcome.error ?? 'The undo was refused.' },
    });
  }

  const working =
    phase.name === 'working' ||
    phase.name === 'document-working' ||
    (phase.name === 'pick' && phase.reading);

  function closeDialog(): void {
    if (phase.name === 'document-preview') discardDocument(phase.operation.id);
    onClose();
  }

  return (
    <Dialog
      open={open}
      title="Import"
      // While a run is in flight, every way out - Escape, the backdrop, the X - stops the run
      // rather than abandoning it; the report then says what was made and what was not.
      onClose={working ? stop : closeDialog}
      actions={
        working ? (
          <Button variant="secondary" onClick={stop}>
            Stop import
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={closeDialog}>
              {phase.name === 'report' || phase.name === 'document-report' ? 'Done' : 'Cancel'}
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
                    void run(phase.plan, phase.losses);
                  }}
                >
                  Import {String(phase.plan.totalItems)}{' '}
                  {phase.plan.totalItems === 1 ? 'item' : 'items'}
                </Button>
              </>
            ) : null}
            {phase.name === 'document-preview' ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    discardDocument(phase.operation.id);
                    setPhase({ name: 'pick', reading: false, error: null });
                  }}
                >
                  Choose a different file
                </Button>
                <Button
                  onClick={() => {
                    void runDocument(phase);
                  }}
                >
                  Import {String(phase.operation.itemCount ?? phase.plan.items.length)} items
                </Button>
              </>
            ) : null}
          </>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-4 break-words">
        {/* One live region for the dialog's whole life, mounted before any of its texts, so phase
            changes are actually announced - a region inserted together with its text is the
            canonical reason one never speaks (see a11y/announcer.ts). Deliberately coarse: phases,
            not per-item progress. */}
        <div role="status" className="sr-only">
          {liveText(phase)}
        </div>

        {phase.name === 'pick' ? (
          <PickStep
            reading={phase.reading}
            error={phase.error}
            onChose={(files) => void chose(files)}
          />
        ) : null}

        {phase.name === 'preview' ? <Preview plan={phase.plan} losses={phase.losses} /> : null}

        {phase.name === 'document-preview' ? (
          <DocumentPreview operation={phase.operation} plan={phase.plan} />
        ) : null}

        {phase.name === 'working' ? (
          <Text tone="muted">
            Importing… {String(phase.done)} of {String(phase.total)} items.
          </Text>
        ) : null}

        {phase.name === 'document-working' ? (
          <Text tone="muted">Publishing {String(phase.total)} imported items atomically…</Text>
        ) : null}

        {phase.name === 'report' ? (
          <Report
            report={phase.report}
            losses={phase.losses}
            undo={phase.undo}
            onUndo={() => {
              void undo(phase);
            }}
            onRetry={
              phase.report.couldNotStart === undefined
                ? undefined
                : () => {
                    void run(phase.plan, phase.losses);
                  }
            }
          />
        ) : null}

        {phase.name === 'document-report' ? (
          <DocumentReport
            operation={phase.operation}
            plan={phase.plan}
            undo={phase.undo}
            onUndo={() => {
              void undoDocument(phase);
            }}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
