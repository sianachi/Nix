import { Button, Card, Dialog, Field, Icon, Input, Tag, Text } from '@nix/ui';
import { Copy, Download, FileUp, LayoutTemplate, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { useApiClient } from '../api/api-client-provider';
import { fileNameFrom, saveArchive } from '../export/export-archive';
import { useTemplateLibrary } from './template-library-context';
import {
  deleteTemplate,
  exportTemplate,
  importTemplateFile,
  previewTemplateFile,
  type TemplateSummary,
} from './template-api';
import { templateFailure } from './use-templates';
import { TemplateViewPreview } from './template-view-preview';
import { useWorkspace } from '../workspaces/workspace-context';
import { isCanceledError } from '@nix/api-client';

function originLabel(template: TemplateSummary): string {
  if (template.origin === 'managed') return 'Managed from file';
  if (template.origin === 'seed') return 'Built in';
  return 'Workspace';
}

interface DuplicateAttempt {
  readonly idempotencyKey: string;
  readonly archive: Blob | null;
  readonly digest: string | null;
}

export function TemplateLibraryPage(): ReactNode {
  const library = useTemplateLibrary();
  const client = useApiClient();
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [failedDuplicate, setFailedDuplicate] = useState<TemplateSummary | null>(null);
  const duplicateAttempts = useRef(new Map<string, DuplicateAttempt>());
  const activeRequests = useRef(new Set<AbortController>());
  useEffect(() => {
    const pendingRequests = activeRequests.current;
    return () => {
      for (const controller of pendingRequests) controller.abort();
      pendingRequests.clear();
    };
  }, []);
  const query = searchParams.get('q') ?? '';
  const targetItemId = searchParams.get('target');
  const parentItemId = searchParams.get('parent');
  const normalized = query.trim().toLocaleLowerCase();
  const visible = library.templates.filter((template) =>
    normalized.length === 0
      ? true
      : `${template.title} ${template.description ?? ''} ${template.viewKinds.join(' ')}`
          .toLocaleLowerCase()
          .includes(normalized),
  );

  function beginTemplate(templateId: string): void {
    if (targetItemId !== null) {
      void navigate(`/w/${workspaceId}/items/${targetItemId}/templates/apply/${templateId}`);
      return;
    }
    const suffix = parentItemId === null ? '' : `?parent=${encodeURIComponent(parentItemId)}`;
    void navigate(`/w/${workspaceId}/templates/${templateId}/create${suffix}`);
  }

  async function remove(): Promise<void> {
    if (deleting === null) return;
    setWorking(true);
    setDeleteError(null);
    const controller = new AbortController();
    activeRequests.current.add(controller);
    try {
      await client.execute(deleteTemplate(deleting), { signal: controller.signal });
      if (controller.signal.aborted) return;
      setDeleting(null);
    } catch (error) {
      if (controller.signal.aborted || isCanceledError(error)) return;
      setDeleteError(templateFailure(error, 'This template could not be deleted.'));
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setWorking(false);
    }
  }

  async function download(template: TemplateSummary): Promise<void> {
    setDownloading(template.id);
    setDownloadError(null);
    const controller = new AbortController();
    activeRequests.current.add(controller);
    try {
      const result = await client.download(exportTemplate(template.id), {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      saveArchive({
        blob: result.blob,
        fileName: fileNameFrom(result.headers['content-disposition'] ?? null),
        itemCount: template.childCount + 1,
        omittedCount: 0,
      });
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      setDownloadError(templateFailure(reason, 'This template could not be downloaded.'));
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setDownloading(null);
    }
  }

  async function duplicate(template: TemplateSummary): Promise<void> {
    setDuplicating(template.id);
    setDuplicateError(null);
    setFailedDuplicate(null);
    const controller = new AbortController();
    activeRequests.current.add(controller);
    let attempt = duplicateAttempts.current.get(template.id) ?? {
      idempotencyKey: globalThis.crypto.randomUUID(),
      archive: null,
      digest: null,
    };
    duplicateAttempts.current.set(template.id, attempt);
    try {
      let archive = attempt.archive;
      if (archive === null) {
        const exported = await client.download(exportTemplate(template.id), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        archive = exported.blob;
        attempt = { ...attempt, archive };
        duplicateAttempts.current.set(template.id, attempt);
      }
      let digest = attempt.digest;
      if (digest === null) {
        const preview = await client.execute(previewTemplateFile(workspaceId, archive), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        digest = preview.digest;
        attempt = { ...attempt, digest };
        duplicateAttempts.current.set(template.id, attempt);
      }

      const imported = await client.execute(
        importTemplateFile(workspaceId, archive, digest, attempt.idempotencyKey),
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      duplicateAttempts.current.delete(template.id);
      void navigate(`/w/${workspaceId}/templates/${imported.templateId}/edit`);
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      setDuplicateError(templateFailure(reason, 'This template could not be duplicated.'));
      setFailedDuplicate(template);
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setDuplicating(null);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex max-w-2xl flex-col gap-1">
            <Text variant="kicker">Workspace library</Text>
            <Text variant="h1" as="h1">
              Templates
            </Text>
            <Text tone="muted">
              Reuse the fields, views, and starting content your team has agreed on.
            </Text>
          </div>
          {library.capabilities.canManage ? (
            <Button
              variant="secondary"
              onClick={() => {
                void navigate(`/w/${workspaceId}/templates/import`);
              }}
            >
              <Icon icon={FileUp} size="sm" /> Import template
            </Button>
          ) : null}
        </header>

        <Field label="Search templates">
          {(control) => (
            <Input
              {...control}
              type="search"
              value={query}
              placeholder="Name, description, or view"
              onChange={(event) => {
                const next = new URLSearchParams(searchParams);
                if (event.target.value.length === 0) next.delete('q');
                else next.set('q', event.target.value);
                setSearchParams(next, { replace: true });
              }}
            />
          )}
        </Field>
        {downloadError === null ? null : (
          <Text variant="bodySmall" role="alert" className="bg-surface px-3 py-2">
            {downloadError}
          </Text>
        )}
        {duplicateError === null ? null : (
          <div role="alert" className="flex flex-wrap items-center gap-3 bg-surface px-3 py-2">
            <Text variant="bodySmall" className="flex-1">
              {duplicateError} Retrying Duplicate will safely continue the same attempt.
            </Text>
            {failedDuplicate === null ? null : (
              <Button
                variant="secondary"
                onClick={() => {
                  const template = failedDuplicate;
                  duplicateAttempts.current.delete(template.id);
                  void duplicate(template);
                }}
              >
                Start a separate duplicate
              </Button>
            )}
          </div>
        )}

        {library.status === 'loading' ? (
          <LibraryNotice title="Loading templates" detail="Reading the shared workspace library." />
        ) : library.status === 'error' ? (
          <LibraryNotice title="Templates could not be loaded" detail={library.error ?? ''}>
            <Button variant="secondary" onClick={library.reload}>
              <Icon icon={RefreshCw} size="sm" /> Try again
            </Button>
          </LibraryNotice>
        ) : library.templates.length === 0 ? (
          <LibraryNotice
            title="No templates yet"
            detail={
              library.capabilities.canManage
                ? 'Open an item and choose Save as template to add the first one.'
                : 'There are no templates available in this workspace.'
            }
          />
        ) : visible.length === 0 ? (
          <LibraryNotice
            title="No templates match"
            detail="Try a different name, description, or view type."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onUse={() => {
                  beginTemplate(template.id);
                }}
                onEdit={() => {
                  void navigate(`/templates/${template.id}/edit`);
                }}
                onDelete={() => {
                  setDeleteError(null);
                  setDeleting(template);
                }}
                onDownload={() => {
                  void download(template);
                }}
                onDuplicate={() => {
                  void duplicate(template);
                }}
                downloading={downloading === template.id}
                duplicating={duplicating === template.id}
                duplicateDisabled={duplicating !== null}
                canDuplicate={
                  library.capabilities.canManage &&
                  template.origin !== 'user' &&
                  template.capabilities.canExport
                }
              />
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={deleting !== null}
        title="Delete this template?"
        onClose={() => {
          if (!working) setDeleting(null);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={working}
              onClick={() => {
                setDeleting(null);
              }}
            >
              Keep template
            </Button>
            <Button disabled={working} onClick={() => void remove()}>
              {working ? 'Deleting…' : 'Delete template'}
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">
          Existing items created from {deleting?.title ?? 'this template'} will not change.
        </Text>
        {deleteError === null ? null : (
          <Text variant="bodySmall" role="alert">
            {deleteError}
          </Text>
        )}
      </Dialog>
    </div>
  );
}

function TemplateCard({
  template,
  onUse,
  onEdit,
  onDelete,
  onDownload,
  onDuplicate,
  downloading,
  duplicating,
  duplicateDisabled,
  canDuplicate,
}: {
  readonly template: TemplateSummary;
  readonly onUse: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onDownload: () => void;
  readonly onDuplicate: () => void;
  readonly downloading: boolean;
  readonly duplicating: boolean;
  readonly duplicateDisabled: boolean;
  readonly canDuplicate: boolean;
}): ReactNode {
  const contents = [
    `${String(template.fieldCount)} ${template.fieldCount === 1 ? 'field' : 'fields'}`,
    `${String(template.viewCount)} ${template.viewCount === 1 ? 'view' : 'views'}`,
    `${String(template.childCount)} ${template.childCount === 1 ? 'item' : 'items'}`,
  ].join(' · ');

  return (
    <Card title={template.title} kicker={originLabel(template)} headingLevel={2}>
      <TemplateViewPreview templateId={template.id} title={template.title} />
      <div className="flex min-h-16 flex-col gap-3">
        <Text variant="bodySmall" tone="muted">
          {template.description ?? 'No description yet.'}
        </Text>
        <Text variant="caption" tone="muted">
          {contents}
        </Text>
        <div className="flex flex-wrap gap-1.5">
          {template.includeBody ? <Tag tone="muted">Content</Tag> : null}
          {template.includeChildren ? <Tag tone="muted">Children</Tag> : null}
          {template.viewKinds.map((kind) => (
            <Tag key={kind}>{kind.replace('_', ' ')}</Tag>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {template.capabilities.canApply ? (
          <Button aria-label={`Use ${template.title} template`} onClick={onUse}>
            <Icon icon={LayoutTemplate} size="sm" /> Use template
          </Button>
        ) : null}
        {template.capabilities.canEdit ? (
          <Button
            variant="secondary"
            aria-label={`Edit ${template.title} template`}
            onClick={onEdit}
          >
            <Icon icon={Pencil} size="sm" /> Edit
          </Button>
        ) : null}
        {canDuplicate ? (
          <Button
            variant="secondary"
            aria-label={`Duplicate ${template.title}`}
            disabled={duplicateDisabled}
            onClick={onDuplicate}
          >
            <Icon icon={Copy} size="sm" /> {duplicating ? 'Duplicating…' : 'Duplicate'}
          </Button>
        ) : null}
        {template.capabilities.canExport ? (
          <Button
            variant="icon"
            aria-label={`Download ${template.title}`}
            disabled={downloading}
            onClick={onDownload}
          >
            <Icon icon={Download} size="sm" />
          </Button>
        ) : null}
        {template.capabilities.canDelete ? (
          <Button variant="icon" aria-label={`Delete ${template.title}`} onClick={onDelete}>
            <Icon icon={Trash2} size="sm" />
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function LibraryNotice({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <Card title={title} kicker="Template library">
      <Text tone="muted">{detail}</Text>
      {children}
    </Card>
  );
}
