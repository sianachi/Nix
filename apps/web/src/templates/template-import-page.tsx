import { Blueprint, Button, Dialog, Icon, Tag, Text, focusRing } from '@nix/ui';
import { ArrowLeft, FileCheck2, FileUp, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import { isCanceledError, isNixApiError, NixErrorKind } from '@nix/api-client';

import { useApiClient } from '../api/api-client-provider';
import { browserSessionStorage } from '../lib/browser-storage';
import { useTemplateLibrary } from './template-library-context';
import {
  beginAndPreviewTemplate,
  cancelTemplateImport,
  commitAndWaitTemplate,
  TemplateImportPreviewSchema,
  type TemplateImportPreview,
} from './template-api';
import { templateFailure } from './use-templates';
import { useWorkspace } from '../workspaces/workspace-context';

const draftKey = (workspaceId: string): string => `nix:template-import:${workspaceId}`;

const FileIdentitySchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  lastModified: z.number().int().nonnegative(),
});

const ImportDraftSchema = z.object({
  importId: z.uuid().nullable(),
  preview: TemplateImportPreviewSchema.nullable(),
  idempotencyKey: z.uuid(),
  fileIdentity: FileIdentitySchema.optional(),
});

type FileIdentity = z.infer<typeof FileIdentitySchema>;

interface ImportDraft {
  readonly importId: string | null;
  readonly preview: TemplateImportPreview | null;
  readonly idempotencyKey: string;
  readonly fileIdentity: FileIdentity | null;
}

function newImportDraft(): ImportDraft {
  return {
    importId: null,
    preview: null,
    idempotencyKey: globalThis.crypto.randomUUID(),
    fileIdentity: null,
  };
}

function identify(file: File): FileIdentity {
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

function isSameFile(file: File, identity: FileIdentity): boolean {
  return (
    file.name === identity.name &&
    file.size === identity.size &&
    file.lastModified === identity.lastModified
  );
}

function readDraft(workspaceId: string): ImportDraft {
  try {
    const raw = browserSessionStorage()?.getItem(draftKey(workspaceId));
    if (raw === null || raw === undefined) return newImportDraft();
    const parsed = ImportDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? { ...parsed.data, fileIdentity: parsed.data.fileIdentity ?? null }
      : newImportDraft();
  } catch {
    return newImportDraft();
  }
}

function writeDraft(workspaceId: string, draft: ImportDraft): void {
  try {
    browserSessionStorage()?.setItem(draftKey(workspaceId), JSON.stringify(draft));
  } catch {
    // Recovery storage is optional; the durable server-side attempt remains authoritative.
  }
}

function forgetDraft(workspaceId: string): void {
  try {
    browserSessionStorage()?.removeItem(draftKey(workspaceId));
  } catch {
    // A blocked storage API must not block cancellation or navigation.
  }
}

export function TemplateImportPage(): ReactNode {
  const client = useApiClient();
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const templateLibrary = useTemplateLibrary();
  const templateCapabilities = templateLibrary.capabilities;
  const templateStatus = templateLibrary.status;
  const [recovered] = useState(() => readDraft(workspaceId));
  const [file, setFile] = useState<File | null>(null);
  const [importId, setImportId] = useState<string | null>(recovered.importId);
  const [preview, setPreview] = useState<TemplateImportPreview | null>(recovered.preview);
  const [idempotencyKey, setIdempotencyKey] = useState(recovered.idempotencyKey);
  const [previewFileIdentity, setPreviewFileIdentity] = useState<FileIdentity | null>(
    recovered.fileIdentity,
  );
  const [commitRequiresDiscard, setCommitRequiresDiscard] = useState(false);
  const [activity, setActivity] = useState<
    'idle' | 'validating' | 'importing' | 'replacing' | 'discarding'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const activeImportId = useRef<string | null>(recovered.importId);
  const previewHeading = useRef<HTMLDivElement | null>(null);
  const working = activity !== 'idle';

  useEffect(
    () => () => {
      activeRequest.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (file === null && preview === null && importId === null && previewFileIdentity === null)
      return;
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    globalThis.addEventListener('beforeunload', warn);
    return () => {
      globalThis.removeEventListener('beforeunload', warn);
    };
  }, [file, importId, preview, previewFileIdentity]);

  useEffect(() => {
    if (preview !== null) previewHeading.current?.focus();
  }, [preview]);

  function choose(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0] ?? null;
    const keepsRecoveredAttempt =
      selected !== null &&
      previewFileIdentity !== null &&
      isSameFile(selected, previewFileIdentity);
    if (keepsRecoveredAttempt) {
      setFile(selected);
      setError(null);
      writeDraft(workspaceId, {
        importId,
        preview,
        idempotencyKey,
        fileIdentity: identify(selected),
      });
      return;
    }
    void replaceSelection(selected, event.currentTarget);
  }

  async function replaceSelection(selected: File | null, input: HTMLInputElement): Promise<void> {
    const request = activeRequest.current;
    request?.abort();
    if (activeRequest.current === request) activeRequest.current = null;
    const previousImportId = activeImportId.current;
    setError(null);
    if (previousImportId !== null) {
      setActivity('replacing');
      try {
        await cancelTemplateImport(client, previousImportId);
      } catch (reason) {
        // Let the same replacement be chosen again. React still owns the previous archive state.
        input.value = '';
        setError(
          `${templateFailure(reason, 'The previous template import could not be released.')} It remains available to retry or discard.`,
        );
        setActivity('idle');
        return;
      }
      setActivity('idle');
    }

    setFile(selected);
    setPreview(null);
    setCommitRequiresDiscard(false);
    setPreviewFileIdentity(null);
    const nextIdempotencyKey = globalThis.crypto.randomUUID();
    setIdempotencyKey(nextIdempotencyKey);
    setImportId(null);
    activeImportId.current = null;
    if (selected === null) {
      forgetDraft(workspaceId);
      return;
    }
    const fileIdentity = identify(selected);
    setPreviewFileIdentity(fileIdentity);
    writeDraft(workspaceId, {
      importId: null,
      preview: null,
      idempotencyKey: nextIdempotencyKey,
      fileIdentity,
    });
  }

  async function validate(): Promise<void> {
    if (file === null) {
      setError('Choose a .nix template file first.');
      return;
    }
    setActivity('validating');
    setError(null);
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const fileIdentity = identify(file);
    setPreviewFileIdentity(fileIdentity);
    writeDraft(workspaceId, {
      importId,
      preview,
      idempotencyKey,
      fileIdentity,
    });
    try {
      const result = await beginAndPreviewTemplate(
        client,
        {
          workspaceId,
          fileName: file.name,
          mediaType: file.type || 'application/octet-stream',
          byteLength: file.size,
          idempotencyKey,
        },
        file,
        controller.signal,
        (startedImportId) => {
          activeImportId.current = startedImportId;
          setImportId(startedImportId);
          setPreviewFileIdentity(fileIdentity);
          writeDraft(workspaceId, {
            importId: startedImportId,
            preview: null,
            idempotencyKey,
            fileIdentity,
          });
        },
      );
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      if (result.preview === null) {
        throw new Error('The template preview did not become ready.');
      }
      activeImportId.current = result.id;
      setImportId(result.id);
      setPreview(result.preview);
      setCommitRequiresDiscard(false);
      setPreviewFileIdentity(fileIdentity);
      writeDraft(workspaceId, {
        importId: result.id,
        preview: result.preview,
        idempotencyKey,
        fileIdentity,
      });
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      const recovery =
        activeImportId.current === null
          ? 'The selected archive and retry identity remain in this tab, so you can safely try validation again.'
          : 'The same durable attempt is retained, so you can safely try validation again.';
      setError(
        `${templateFailure(reason, 'This template file could not be validated.')} ${recovery}`,
      );
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setActivity('idle');
      }
    }
  }

  async function finish(): Promise<void> {
    if (preview === null || importId === null || commitRequiresDiscard) return;
    setActivity('importing');
    setError(null);
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      await commitAndWaitTemplate(client, importId, preview.digest, controller.signal);
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      activeImportId.current = null;
      setImportId(null);
      forgetDraft(workspaceId);
      void navigate(`/w/${workspaceId}/templates`);
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      if (
        isNixApiError(reason) &&
        (reason.code === 'template.file_changed' ||
          (reason.kind === NixErrorKind.Operation && reason.code.startsWith('template')))
      ) {
        setCommitRequiresDiscard(true);
        setError(
          `${reason.detail ?? 'The template import cannot continue.'} Discard this attempt before previewing the file again.`,
        );
        return;
      }
      setError(
        `${templateFailure(reason, 'This template could not be added to the library.')} This durable attempt is retained and can be retried safely.`,
      );
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setActivity('idle');
      }
    }
  }

  async function discard(): Promise<void> {
    const request = activeRequest.current;
    request?.abort();
    if (activeRequest.current === request) activeRequest.current = null;
    setActivity('discarding');
    setError(null);
    const currentImportId = activeImportId.current;
    try {
      if (currentImportId !== null) await cancelTemplateImport(client, currentImportId);
      activeImportId.current = null;
      setImportId(null);
      forgetDraft(workspaceId);
      void navigate(`/w/${workspaceId}/templates`);
    } catch (reason) {
      setDiscarding(false);
      setError(templateFailure(reason, 'This staged template import could not be discarded.'));
      setActivity('idle');
    }
  }

  if (templateStatus === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Text tone="muted">Checking template access…</Text>
      </div>
    );
  }

  if (templateStatus === 'error') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Blueprint className="flex max-w-lg flex-col items-start gap-3 p-6">
          <Icon icon={ShieldCheck} size="md" />
          <Text variant="h2" as="h1">
            Template library unavailable
          </Text>
          <Text tone="muted">
            {templateLibrary.error ??
              'The template library could not be loaded. Check the connection.'}
          </Text>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={templateLibrary.reload}>
              Try again
            </Button>
            <Button
              variant="secondary"
              onClick={() => void navigate(`/w/${workspaceId}/templates`)}
            >
              Back to templates
            </Button>
          </div>
        </Blueprint>
      </div>
    );
  }

  if (!templateCapabilities.canManage) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Blueprint className="flex max-w-lg flex-col items-start gap-3 p-6">
          <Icon icon={ShieldCheck} size="md" />
          <Text variant="h2" as="h1">
            Template import unavailable
          </Text>
          <Text tone="muted">
            You can browse and download workspace templates, but you cannot add or change them.
          </Text>
          <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
            Back to templates
          </Button>
        </Blueprint>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-divider px-4 py-3">
        <Button
          variant="icon"
          aria-label="Cancel template import"
          onClick={() => {
            setDiscarding(true);
          }}
        >
          <Icon icon={ArrowLeft} size="sm" />
        </Button>
        <div className="min-w-0 flex-1">
          <Text variant="h3" as="h1">
            Import template
          </Text>
          <Text variant="caption" tone="muted">
            Validate before anything enters the workspace library
          </Text>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-2">
          <section className="flex flex-col gap-4">
            <div>
              <Text variant="kicker">Template file</Text>
              <Text variant="h2" as="h2">
                Choose a .nix file
              </Text>
              <Text variant="bodySmall" tone="muted">
                Nix checks the archive version, property types, view kinds, and every entry before
                import.
              </Text>
            </div>
            <Blueprint className="flex flex-col items-start gap-4 p-5">
              <Icon icon={FileUp} size="md" />
              <label className="flex flex-col gap-2">
                <Text variant="bodySmall" as="span">
                  Template file
                </Text>
                <input
                  type="file"
                  accept=".nix,application/x-nix-template,application/zip"
                  onChange={choose}
                  disabled={working}
                  className={`max-w-full text-sm ${focusRing}`}
                />
              </label>
              {file === null ? null : (
                <Text variant="caption" tone="muted">
                  Selected: {file.name}
                </Text>
              )}
              {file === null && preview === null && previewFileIdentity !== null ? (
                <Text variant="bodySmall" role="status">
                  A previous attempt for {previewFileIdentity.name} can be resumed. Select that same
                  file again. Nix kept the retry details, but this browser did not retain the
                  archive bytes.
                </Text>
              ) : null}
              {file === null &&
              preview === null &&
              importId !== null &&
              previewFileIdentity === null ? (
                <Text variant="bodySmall" role="status">
                  A durable attempt is still recorded, but its local file details are unavailable.
                  Discard it before choosing the archive again.
                </Text>
              ) : null}
              <Button
                disabled={working || file === null || preview !== null}
                onClick={() => void validate()}
              >
                <Icon icon={ShieldCheck} size="sm" />{' '}
                {activity === 'validating' ? 'Validating…' : 'Validate file'}
              </Button>
              {activity === 'replacing' ? (
                <Text variant="caption" role="status" tone="muted">
                  Releasing the previous staged import…
                </Text>
              ) : null}
            </Blueprint>
            {error === null ? null : (
              <div className="flex flex-col items-start gap-2 bg-surface px-3 py-2">
                <Text variant="bodySmall" role="alert">
                  {error}
                </Text>
                {commitRequiresDiscard ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDiscarding(true);
                    }}
                  >
                    Discard attempt
                  </Button>
                ) : null}
              </div>
            )}
          </section>

          <section aria-label="Import preview" className="flex flex-col gap-4">
            <div>
              <Text variant="kicker">Preview</Text>
              <Text variant="h2" as="h2">
                What will be added
              </Text>
            </div>
            {preview === null ? (
              <Blueprint className="p-5">
                <Text tone="muted">
                  Choose and validate a file to see its contents. Nothing is imported during
                  validation.
                </Text>
              </Blueprint>
            ) : (
              <Blueprint className="flex flex-col gap-4 p-5">
                <div ref={previewHeading} tabIndex={-1} className={focusRing}>
                  <Icon icon={FileCheck2} size="md" />
                  <Text variant="h3">{preview.profile.name}</Text>
                  {preview.profile.description.length === 0 ? null : (
                    <Text variant="bodySmall" tone="muted">
                      {preview.profile.description}
                    </Text>
                  )}
                  <Text variant="caption" role="status" aria-live="polite" tone="muted">
                    Validation complete. Review this preview before adding it to the library.
                  </Text>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <ImportCount label="Items" value={preview.itemCount} />
                  <ImportCount label="Bodies" value={preview.bodyCount} />
                  <ImportCount label="Views" value={preview.viewCount} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {preview.profile.includeBody ? <Tag tone="muted">Content</Tag> : null}
                  {preview.profile.includeChildren ? <Tag tone="muted">Children</Tag> : null}
                  <Tag>{preview.rootItemType}</Tag>
                </div>
                {file === null ? (
                  <Text variant="bodySmall" role="status">
                    This recovered preview is ready because Nix retained the uploaded archive for
                    this durable attempt. This browser stored recovery details, not local file
                    bytes.
                  </Text>
                ) : null}
                <Button
                  disabled={working || importId === null || commitRequiresDiscard}
                  onClick={() => void finish()}
                >
                  {activity === 'importing' ? 'Importing…' : 'Add to library'}
                </Button>
              </Blueprint>
            )}
          </section>
        </div>
      </main>

      <Dialog
        open={discarding}
        title="Discard this import?"
        onClose={() => {
          if (activity !== 'discarding') setDiscarding(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={activity === 'discarding'}
              onClick={() => {
                setDiscarding(false);
              }}
            >
              Keep reviewing
            </Button>
            <Button disabled={activity === 'discarding'} onClick={() => void discard()}>
              {activity === 'discarding' ? 'Discarding…' : 'Discard import'}
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">
          Any known durable attempt will be cancelled, then the selected file and local recovery
          details will be forgotten.
        </Text>
      </Dialog>
    </div>
  );
}

function ImportCount({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number;
}): ReactNode {
  return (
    <div className="rounded-md bg-surface p-2 text-center">
      <Text variant="h3">{String(value)}</Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </div>
  );
}
