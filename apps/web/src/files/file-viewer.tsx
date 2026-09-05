import { files as fileResources, isNixApiError, type FileRecord } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';

export function FileViewer({ itemId }: { readonly itemId: string }): ReactNode {
  const client = useApiClient();
  const [record, setRecord] = useState<FileRecord | null>(null);
  const [preview, setPreview] = useState<{
    readonly versionId: string;
    readonly url: string | null;
    readonly failed: boolean;
  } | null>(null);
  const [error, setError] = useState<{ readonly itemId: string; readonly message: string } | null>(
    null,
  );
  const [replacing, setReplacing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const replacementRef = useRef<HTMLInputElement>(null);
  const visibleRecord = record?.itemId === itemId ? record : null;
  const visibleError = error?.itemId === itemId ? error.message : null;
  const currentVersionId = visibleRecord?.current.id;
  const currentPreviewable = visibleRecord?.current.previewable ?? false;
  const currentMediaType = visibleRecord?.current.mediaType ?? '';

  useEffect(() => {
    const controller = new AbortController();
    void client
      .query(fileResources.fileByItem(itemId), { signal: controller.signal })
      .then(setRecord)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError({
            itemId,
            message: isNixApiError(reason)
              ? (reason.detail ?? 'The file metadata is unavailable.')
              : 'The file metadata is unavailable.',
          });
      });
    return () => {
      controller.abort();
    };
  }, [client, itemId]);

  useEffect(() => {
    if (!currentPreviewable || currentVersionId === undefined) return;
    const versionId = currentVersionId;
    const controller = new AbortController();
    let url: string | null = null;
    void fileResources
      .fetchFileContent(client, itemId, undefined, true, controller.signal)
      .then(({ blob }) => {
        url = URL.createObjectURL(blob);
        setPreview({ versionId, url, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview({ versionId, url: null, failed: true });
      });
    return () => {
      controller.abort();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [client, currentPreviewable, currentVersionId, itemId]);

  const currentPreview = preview?.versionId === currentVersionId ? preview : null;

  async function download(versionId?: string): Promise<void> {
    setDownloading(true);
    setError(null);
    try {
      const { blob } = await fileResources.fetchFileContent(client, itemId, versionId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download =
        versionId === undefined
          ? (visibleRecord?.current.fileName ?? 'download')
          : (visibleRecord?.versions.find((version) => version.id === versionId)?.fileName ??
            'download');
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError({
        itemId,
        message: isNixApiError(reason)
          ? (reason.detail ?? 'The download was refused.')
          : reason instanceof Error
            ? reason.message
            : 'The download was refused.',
      });
    } finally {
      setDownloading(false);
    }
  }

  async function replace(file: File): Promise<void> {
    if (visibleRecord === null) return;
    setReplacing(true);
    setError(null);
    try {
      const upload = await client.execute(
        fileResources.beginUpload({
          workspaceId: visibleRecord.workspaceId,
          parentId: null,
          targetItemId: itemId,
          fileName: file.name,
          mediaType: file.type || 'application/octet-stream',
          byteLength: file.size,
          idempotencyKey: `web-file-replace:${crypto.randomUUID()}`,
        }),
      );
      const updated = await fileResources.uploadAndCompleteFile(client, upload, file);
      setRecord(updated);
    } catch (reason) {
      setError({
        itemId,
        message: isNixApiError(reason)
          ? (reason.detail ?? 'The replacement was refused.')
          : reason instanceof Error
            ? reason.message
            : 'The replacement was refused.',
      });
    } finally {
      setReplacing(false);
    }
  }

  if (visibleRecord === null)
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Text variant="note" tone="muted" {...(visibleError === null ? {} : { role: 'alert' })}>
          {visibleError ?? 'Loading file metadata…'}
        </Text>
      </div>
    );
  const file = visibleRecord.current;
  return (
    <section aria-label="File" className="flex flex-1 flex-col gap-4 overflow-y-auto p-8">
      {currentPreview?.url === null ||
      currentPreview?.url === undefined ? null : currentMediaType === 'application/pdf' ? (
        <iframe
          title={file.fileName}
          src={currentPreview.url}
          className="h-[70vh] w-full rounded-md"
        />
      ) : currentMediaType.startsWith('image/') ? (
        <img
          src={currentPreview.url}
          alt={file.fileName}
          className="max-h-screen max-w-full self-start rounded-md object-contain"
        />
      ) : null}
      {file.previewable && currentPreview === null ? (
        <Text variant="note" tone="muted" role="status">
          Loading the authorized preview…
        </Text>
      ) : null}
      {currentPreview?.failed === true ? (
        <Text variant="note" tone="muted" role="alert">
          The preview is unavailable. You can still download the file.
        </Text>
      ) : null}
      {visibleError === null ? null : (
        <Text variant="note" as="p" role="alert">
          {visibleError}
        </Text>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt>Filename</dt>
        <dd>{file.fileName}</dd>
        <dt>Type</dt>
        <dd>{file.mediaType}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(file.byteLength)}</dd>
        <dt>SHA-256</dt>
        <dd className="break-all font-mono">{file.sha256}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button disabled={downloading} onClick={() => void download()}>
          {downloading ? 'Downloading…' : 'Download'}
        </Button>
        <Button
          variant="secondary"
          disabled={replacing}
          onClick={() => replacementRef.current?.click()}
        >
          {replacing ? 'Replacing…' : 'Replace file'}
        </Button>
        <input
          ref={replacementRef}
          type="file"
          className="sr-only"
          aria-label="Choose replacement file"
          onChange={(event) => {
            const selected = event.currentTarget.files?.[0];
            if (selected !== undefined) void replace(selected);
          }}
        />
      </div>
      <div>
        <Text variant="h2" as="h2">
          Version history
        </Text>
        <ul className="mt-2 space-y-2">
          {visibleRecord.versions.map((version) => (
            <li
              key={version.id}
              className="flex items-center justify-between gap-4 rounded-md bg-surface p-3"
            >
              <span>
                Version {String(version.version)} · {formatBytes(version.byteLength)}
                {version.current ? ' · Current' : ''}
              </span>
              <Button
                variant="ghost"
                disabled={downloading}
                onClick={() => void download(version.id)}
              >
                Download
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
