import { Blueprint, Button, Dialog, Icon, Tag, Text, focusRing } from '@nix/ui';
import { ArrowLeft, FileCheck2, FileUp, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import { isCanceledError, isNixApiError } from '@nix/api-client';

import { useApiClient } from '../api/api-client-provider';
import { browserSessionStorage } from '../lib/browser-storage';
import { useTemplateLibrary } from './template-library-context';
import {
  importTemplateFile,
  previewTemplateFile,
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
  preview: TemplateImportPreviewSchema,
  idempotencyKey: z.uuid(),
  fileIdentity: FileIdentitySchema.optional(),
});

type FileIdentity = z.infer<typeof FileIdentitySchema>;

interface ImportDraft {
  readonly preview: TemplateImportPreview | null;
  readonly idempotencyKey: string;
  readonly fileIdentity: FileIdentity | null;
}

function newImportDraft(): ImportDraft {
  return {
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
  const raw = browserSessionStorage()?.getItem(draftKey(workspaceId));
  if (raw === null || raw === undefined) return newImportDraft();
  try {
    const parsed = ImportDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? { ...parsed.data, fileIdentity: parsed.data.fileIdentity ?? null }
      : newImportDraft();
  } catch {
    return newImportDraft();
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
  const [preview, setPreview] = useState<TemplateImportPreview | null>(recovered.preview);
  const [idempotencyKey, setIdempotencyKey] = useState(recovered.idempotencyKey);
  const [previewFileIdentity, setPreviewFileIdentity] = useState<FileIdentity | null>(
    recovered.fileIdentity,
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (file === null && preview === null) return;
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    globalThis.addEventListener('beforeunload', warn);
    return () => {
      globalThis.removeEventListener('beforeunload', warn);
    };
  }, [file, preview]);

  function choose(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    const keepsRecoveredPreview =
      selected !== null &&
      preview !== null &&
      (previewFileIdentity === null || isSameFile(selected, previewFileIdentity));
    if (keepsRecoveredPreview) {
      setError(null);
      return;
    }
    setPreview(null);
    setPreviewFileIdentity(null);
    setIdempotencyKey(globalThis.crypto.randomUUID());
    setError(null);
    browserSessionStorage()?.removeItem(draftKey(workspaceId));
  }

  async function validate(): Promise<void> {
    if (file === null) {
      setError('Choose a .nix template file first.');
      return;
    }
    setWorking(true);
    setError(null);
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const result = await client.execute(previewTemplateFile(workspaceId, file), {
        signal: controller.signal,
      });
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      const fileIdentity = identify(file);
      setPreview(result);
      setPreviewFileIdentity(fileIdentity);
      browserSessionStorage()?.setItem(
        draftKey(workspaceId),
        JSON.stringify({ preview: result, idempotencyKey, fileIdentity }),
      );
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      setError(templateFailure(reason, 'This template file could not be validated.'));
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setWorking(false);
      }
    }
  }

  async function finish(): Promise<void> {
    if (preview === null) return;
    if (file === null) {
      setError('Choose the same .nix file again before adding this recovered draft.');
      return;
    }
    setWorking(true);
    setError(null);
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      await client.execute(importTemplateFile(workspaceId, file, preview.digest, idempotencyKey), {
        signal: controller.signal,
      });
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      browserSessionStorage()?.removeItem(draftKey(workspaceId));
      void navigate(`/w/${workspaceId}/templates`);
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      if (isNixApiError(reason) && reason.code === 'template.file_changed') {
        setPreview(null);
        setPreviewFileIdentity(null);
        browserSessionStorage()?.removeItem(draftKey(workspaceId));
        setError(
          reason.detail ??
            'The selected file changed after preview. Preview it again before importing.',
        );
        return;
      }
      setError(templateFailure(reason, 'This template could not be added to the library.'));
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setWorking(false);
      }
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
                  className={`max-w-full text-sm ${focusRing}`}
                />
              </label>
              {file === null ? null : (
                <Text variant="caption" tone="muted">
                  Selected: {file.name}
                </Text>
              )}
              <Button disabled={working || file === null} onClick={() => void validate()}>
                <Icon icon={ShieldCheck} size="sm" />{' '}
                {working && preview === null ? 'Validating…' : 'Validate file'}
              </Button>
            </Blueprint>
            {error === null ? null : (
              <Text variant="bodySmall" role="alert" className="bg-surface px-3 py-2">
                {error}
              </Text>
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
                <div>
                  <Icon icon={FileCheck2} size="md" />
                  <Text variant="h3">{preview.profile.name}</Text>
                  {preview.profile.description.length === 0 ? null : (
                    <Text variant="bodySmall" tone="muted">
                      {preview.profile.description}
                    </Text>
                  )}
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
                    This recovered preview is ready. Choose the same file again to import it.
                  </Text>
                ) : null}
                <Button disabled={working || file === null} onClick={() => void finish()}>
                  {working ? 'Importing…' : 'Add to library'}
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
          setDiscarding(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDiscarding(false);
              }}
            >
              Keep reviewing
            </Button>
            <Button
              onClick={() => {
                browserSessionStorage()?.removeItem(draftKey(workspaceId));
                void navigate(`/w/${workspaceId}/templates`);
              }}
            >
              Discard import
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">
          The selected file and its validation preview will be forgotten.
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
