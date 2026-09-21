import { files as fileResources, isNixApiError, items as coreItems } from '@nix/api-client';
import { Button, Icon, Text, blueprintFrame, cn, focusRing } from '@nix/ui';
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Download,
  FolderInput,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';

import { announce } from '../../a11y/announcer';
import { useApiClient } from '../../api/api-client-provider';
import { useWorkspace } from '../../workspaces/workspace-context';
import { useWorkspaceTree } from '../../items/use-workspace-tree';
import { EmptyPanel, ErrorPanel, LoadingPanel } from '../../components/states/status-panels';
import { formatBytes, fileKindLabel, formatWhen } from '../../files/file-facts';
import { CreateItemControl } from '../core/create-item-control';
import type { Item } from '../core/container-model';
import type { ViewRendererProps } from '../core/view-kinds';
import { driveBodyKindLabel, driveKindIcon, isDriveContainerCandidate } from './drive-icons';
import { DriveMoveDialog, type DriveMoveDestination } from './drive-move-dialog';
import { useDriveFileInfo, type DriveFileInfo } from './use-drive-file-info';

/**
 * The drive: a container's children as a file manager, list or grid.
 *
 * Issue #54's shape - a drive is a *view* over any container's children, not a kind of item, so
 * this component is exactly one more entry in `VIEW_KINDS` and touches nothing about what an item
 * can be. Two things every other view here does not need: it fetches file facts (size, media
 * type) itself, lazily, because `Item` does not carry them (`use-drive-file-info.ts`); and it is
 * the one view whose rows can be dragged into each other rather than only into the sidebar.
 */

export const DRIVE_LAYOUTS = ['list', 'grid'] as const;
export type DriveLayout = (typeof DRIVE_LAYOUTS)[number];
export const DEFAULT_DRIVE_LAYOUT: DriveLayout = 'list';

/** Which layout to draw, given what the view stores. Unrecognised and absent both mean list. */
function resolveLayout(stored: string | null | undefined): DriveLayout {
  return DRIVE_LAYOUTS.find((candidate) => candidate === stored) ?? DEFAULT_DRIVE_LAYOUT;
}

type SortKey = 'name' | 'kind' | 'size' | 'modified';
type SortDirection = 'ascending' | 'descending';

interface SortState {
  readonly key: SortKey;
  readonly direction: SortDirection;
}

/** The size in bytes this row would sort by, or -1 for anything that is not a file yet. */
function sizeOf(info: DriveFileInfo | undefined): number {
  return info?.status === 'ready' ? info.record.current.byteLength : -1;
}

/** The word this row would sort and print under "Kind". */
function kindOf(item: Item, info: DriveFileInfo | undefined): string {
  if (item.type !== 'file') return driveBodyKindLabel(item.type);
  if (info?.status === 'ready')
    return fileKindLabel(info.record.current.fileName, info.record.current.mediaType);
  return 'File';
}

function compareRows(
  a: Item,
  b: Item,
  sort: SortState,
  fileInfo: ReadonlyMap<string, DriveFileInfo>,
): number {
  const direction = sort.direction === 'ascending' ? 1 : -1;
  switch (sort.key) {
    case 'name':
      return direction * a.title.localeCompare(b.title);
    case 'kind':
      return direction * kindOf(a, fileInfo.get(a.id)).localeCompare(kindOf(b, fileInfo.get(b.id)));
    case 'size':
      return direction * (sizeOf(fileInfo.get(a.id)) - sizeOf(fileInfo.get(b.id)));
    case 'modified':
      return direction * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  }
}

export function DriveView(props: ViewRendererProps): ReactNode {
  const { container, view, onOpen } = props;
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const tree = useWorkspaceTree();

  const layout = resolveLayout(view.layout);

  // Kept in component state, deliberately: the drive's other choices (columns, cover, grouping)
  // all persist to the view record through `structured-view-configuration.tsx`'s generic field
  // handling, but a sort typed here is a way of looking at this session's screenful rather than a
  // property of the view somebody else opens later. Persisting it is real future work - it would
  // want the same `sortBy`/`sortDescending` fields every other kind already stores - and is out of
  // scope for landing the kind itself.
  const [sort, setSort] = useState<SortState>({ key: 'name', direction: 'ascending' });

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [dropTargetRoot, setDropTargetRoot] = useState(false);
  const [dropTargetRow, setDropTargetRow] = useState<string | null>(null);
  const [dragging, setDragging] = useState<readonly string[] | null>(null);

  // The container's own parent, for the Move dialog's "Parent" destination. `undefined` while it
  // is unknown - either still being asked for, or this drive is drawing a workspace root, which
  // has no parent to offer.
  const [parent, setParent] = useState<{ readonly id: string | null } | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    // Deferred a microtask, the same way `use-bookmarks.ts`'s loader defers its own first read:
    // setting state synchronously in an effect body is the cascading render
    // `react-hooks/set-state-in-effect` exists to stop.
    queueMicrotask(() => {
      if (cancelled) return;
      setParent(undefined);
    });

    if (container.itemId === null) return;
    const itemId = container.itemId;
    client
      .query(coreItems.itemById(itemId))
      .then((item) => {
        if (!cancelled) setParent({ id: item.parentId });
      })
      .catch(() => {
        if (!cancelled) setParent(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [client, container.itemId]);

  const fileItemIds = useMemo(
    () => container.children.filter((item) => item.type === 'file').map((item) => item.id),
    [container.children],
  );
  const fileInfo = useDriveFileInfo(fileItemIds);

  const rows = useMemo(
    () => [...container.children].sort((a, b) => compareRows(a, b, sort, fileInfo)),
    [container.children, sort, fileInfo],
  );

  const destinations: readonly DriveMoveDestination[] = useMemo(
    () =>
      container.children
        .filter(isDriveContainerCandidate)
        .map((item) => ({ id: item.id, title: item.title })),
    [container.children],
  );

  function changeSort(key: SortKey): void {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
        : { key, direction: 'ascending' },
    );
  }

  function toggleSelect(itemId: string, shiftKey: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (shiftKey && lastClicked !== null) {
        const ids = rows.map((row) => row.id);
        const from = ids.indexOf(lastClicked);
        const to = ids.indexOf(itemId);
        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          for (const id of ids.slice(start, end + 1)) next.add(id);
          return next;
        }
      }
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
    setLastClicked(itemId);
  }

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  function toggleSelectAll(): void {
    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)));
  }

  async function downloadSelected(): Promise<void> {
    const items = rows.filter((row) => selected.has(row.id));
    const files = items.filter((row) => row.type === 'file');
    const skipped = items.length - files.length;
    setStatus(
      `Downloading ${String(files.length)} ${files.length === 1 ? 'file' : 'files'}${
        skipped > 0
          ? `; skipping ${String(skipped)} non-file ${skipped === 1 ? 'item' : 'items'}`
          : ''
      }…`,
    );
    for (const item of files) {
      try {
        // Zipping the selection through the export worker is out of scope here; each file is
        // downloaded on its own, one at a time, exactly as opening the file page and clicking
        // Download would do.
        const { blob } = await fileResources.fetchFileContent(client, item.id);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = item.title || 'download';
        anchor.click();
        URL.revokeObjectURL(url);
      } catch {
        // One file's refusal must not stop the rest of the selection from downloading.
      }
    }
    setStatus(null);
    announce(`${String(files.length)} ${files.length === 1 ? 'file' : 'files'} downloaded.`);
  }

  async function moveSelected(targetParentId: string | null): Promise<void> {
    setMoveOpen(false);
    const ids = [...selected];
    for (const id of ids) {
      await tree.move(id, targetParentId, null);
    }
    setSelected(new Set());
    await container.reload();
    announce(`${String(ids.length)} ${ids.length === 1 ? 'item' : 'items'} moved.`);
  }

  async function uploadFiles(files: FileList): Promise<void> {
    setStatus(
      files.length === 1 ? 'Uploading 1 file…' : `Uploading ${String(files.length)} files…`,
    );
    try {
      for (const file of Array.from(files)) {
        const upload = await client.execute(
          fileResources.beginUpload({
            workspaceId,
            parentId: container.itemId,
            fileName: file.name,
            mediaType: file.type || 'application/octet-stream',
            byteLength: file.size,
            idempotencyKey: `web-drive-upload:${crypto.randomUUID()}`,
          }),
        );
        await fileResources.uploadAndCompleteFile(client, upload, file);
      }
      await container.reload();
      announce(files.length === 1 ? 'File uploaded.' : `${String(files.length)} files uploaded.`);
    } catch (error) {
      announce(
        isNixApiError(error)
          ? (error.detail ?? 'The file could not be uploaded.')
          : 'The file could not be uploaded.',
      );
    } finally {
      setStatus(null);
    }
  }

  function onRootDragOver(event: DragEvent<HTMLDivElement>): void {
    if (dragging !== null) return; // an internal row drag, not an OS file drop
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      setDropTargetRoot(true);
    }
  }

  function onRootDrop(event: DragEvent<HTMLDivElement>): void {
    setDropTargetRoot(false);
    if (dragging !== null) return;
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void uploadFiles(event.dataTransfer.files);
  }

  function onRowDragStart(item: Item, event: DragEvent<HTMLElement>): void {
    const ids = selected.has(item.id) ? [...selected] : [item.id];
    setDragging(ids);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', ids.join(','));
  }

  function onRowDragEnd(): void {
    setDragging(null);
    setDropTargetRow(null);
  }

  function onRowDragOver(item: Item, event: DragEvent<HTMLElement>): void {
    if (dragging === null || !isDriveContainerCandidate(item) || dragging.includes(item.id)) return;
    event.preventDefault();
    setDropTargetRow(item.id);
  }

  function onRowDrop(item: Item, event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    const ids = dragging;
    setDragging(null);
    setDropTargetRow(null);
    if (ids === null || ids.includes(item.id) || !isDriveContainerCandidate(item)) return;
    void (async () => {
      for (const id of ids) {
        await tree.move(id, item.id, null);
      }
      setSelected(new Set());
      await container.reload();
    })();
  }

  if (container.status === 'loading') return <LoadingPanel label="this drive" />;
  if (container.status === 'error')
    return (
      <ErrorPanel
        title="This drive could not be read"
        detail={container.error ?? 'Something went wrong reading this container.'}
      />
    );

  if (rows.length === 0) {
    return (
      <EmptyPanel
        title="Nothing in here yet"
        detail="Items added to this one, or files dropped onto this drive, appear here."
        action={<CreateItemControl label="Add the first item" onCreate={container.create} />}
      />
    );
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col gap-3',
        dropTargetRoot && 'outline-2 -outline-offset-2 outline-accent',
      )}
      onDragOver={onRootDragOver}
      onDragLeave={() => {
        setDropTargetRoot(false);
      }}
      onDrop={onRootDrop}
    >
      {status !== null ? (
        <Text variant="note" tone="muted" role="status">
          {status}
        </Text>
      ) : null}

      {selected.size > 0 ? (
        <div
          role="toolbar"
          aria-label="Selected items"
          className={cn(blueprintFrame, 'flex items-center gap-3 bg-surface p-2')}
        >
          <Text variant="body" as="span">
            {`${String(selected.size)} selected`}
          </Text>
          <Button variant="secondary" onClick={() => void downloadSelected()}>
            <Icon icon={Download} size="sm" />
            Download
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setMoveOpen(true);
            }}
          >
            <Icon icon={FolderInput} size="sm" />
            Move to…
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setSelected(new Set());
            }}
          >
            Clear
          </Button>
        </div>
      ) : null}

      {layout === 'grid' ? (
        <DriveGrid
          rows={rows}
          fileInfo={fileInfo}
          selected={selected}
          dropTargetRow={dropTargetRow}
          onOpen={onOpen}
          onToggleSelect={toggleSelect}
          onDragStart={onRowDragStart}
          onDragOver={onRowDragOver}
          onDragEnd={onRowDragEnd}
          onDrop={onRowDrop}
        />
      ) : (
        <DriveTable
          rows={rows}
          fileInfo={fileInfo}
          sort={sort}
          selected={selected}
          allSelected={allSelected}
          dropTargetRow={dropTargetRow}
          onOpen={onOpen}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
          onChangeSort={changeSort}
          onDragStart={onRowDragStart}
          onDragOver={onRowDragOver}
          onDragEnd={onRowDragEnd}
          onDrop={onRowDrop}
        />
      )}

      <CreateItemControl label="Add an item" onCreate={container.create} className="self-start" />

      <DriveMoveDialog
        open={moveOpen}
        onClose={() => {
          setMoveOpen(false);
        }}
        selectedCount={selected.size}
        destinations={destinations.filter((destination) => !selected.has(destination.id))}
        parent={parent}
        onMove={(targetParentId) => {
          void moveSelected(targetParentId);
        }}
      />
    </div>
  );
}

interface RowsProps {
  readonly rows: readonly Item[];
  readonly fileInfo: ReadonlyMap<string, DriveFileInfo>;
  readonly selected: ReadonlySet<string>;
  readonly dropTargetRow: string | null;
  readonly onOpen: (itemId: string) => void;
  readonly onToggleSelect: (itemId: string, shiftKey: boolean) => void;
  readonly onDragStart: (item: Item, event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (item: Item, event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
  readonly onDrop: (item: Item, event: DragEvent<HTMLElement>) => void;
}

function DriveTable(
  props: RowsProps & {
    readonly sort: SortState;
    readonly allSelected: boolean;
    readonly onToggleSelectAll: () => void;
    readonly onChangeSort: (key: SortKey) => void;
  },
): ReactNode {
  const {
    rows,
    fileInfo,
    sort,
    selected,
    allSelected,
    dropTargetRow,
    onOpen,
    onToggleSelect,
    onToggleSelectAll,
    onChangeSort,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDrop,
  } = props;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">This drive's contents</caption>
        <thead>
          <tr>
            <th scope="col" className="border-b border-divider p-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleSelectAll}
                aria-label="Select all rows"
                className={focusRing}
              />
            </th>
            <SortableHeader label="Name" columnKey="name" sort={sort} onChangeSort={onChangeSort} />
            <SortableHeader label="Kind" columnKey="kind" sort={sort} onChangeSort={onChangeSort} />
            <SortableHeader
              label="Size"
              columnKey="size"
              sort={sort}
              onChangeSort={onChangeSort}
              align="end"
            />
            <SortableHeader
              label="Modified"
              columnKey="modified"
              sort={sort}
              onChangeSort={onChangeSort}
              align="end"
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const info = fileInfo.get(item.id);
            const RowIcon = driveKindIcon(item);
            const isSelected = selected.has(item.id);
            return (
              <tr
                key={item.id}
                draggable
                onDragStart={(event) => {
                  onDragStart(item, event);
                }}
                onDragOver={(event) => {
                  onDragOver(item, event);
                }}
                onDragEnd={onDragEnd}
                onDrop={(event) => {
                  onDrop(item, event);
                }}
                className={cn(
                  isSelected && 'bg-accent/10',
                  dropTargetRow === item.id && 'outline-2 -outline-offset-2 outline-accent',
                )}
              >
                <td className="border-b border-divider p-2">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onClick={(event) => {
                      onToggleSelect(item.id, event.shiftKey);
                    }}
                    onChange={() => undefined}
                    aria-label={`Select ${item.title || 'Untitled'}`}
                    className={focusRing}
                  />
                </td>
                <td className="border-b border-divider p-2">
                  <button
                    type="button"
                    onClick={() => {
                      onOpen(item.id);
                    }}
                    className={cn('flex items-center gap-2 text-left', focusRing)}
                  >
                    <Icon icon={RowIcon} size="sm" />
                    <Text variant="body" as="span">
                      {item.title || 'Untitled'}
                    </Text>
                  </button>
                </td>
                <td className="border-b border-divider p-2">
                  <Text variant="body" as="span" tone="muted">
                    {kindOf(item, info)}
                  </Text>
                </td>
                <td className="border-b border-divider p-2 text-right">
                  <Text variant="body" as="span" tone="muted">
                    {item.type === 'file'
                      ? info?.status === 'ready'
                        ? formatBytes(info.record.current.byteLength)
                        : '—'
                      : '—'}
                  </Text>
                </td>
                <td className="border-b border-divider p-2 text-right">
                  <Text variant="body" as="span" tone="muted">
                    {formatWhen(item.updatedAt)}
                  </Text>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader({
  label,
  columnKey,
  sort,
  onChangeSort,
  align = 'start',
}: {
  readonly label: string;
  readonly columnKey: SortKey;
  readonly sort: SortState;
  readonly onChangeSort: (key: SortKey) => void;
  readonly align?: 'start' | 'end';
}): ReactNode {
  const sorted = sort.key === columnKey;
  const glyph: LucideIcon = sorted
    ? sort.direction === 'ascending'
      ? ArrowUp
      : ArrowDown
    : ChevronsUpDown;

  return (
    <th
      scope="col"
      aria-sort={sorted ? sort.direction : 'none'}
      className={cn('border-b border-divider p-0', align === 'end' ? 'text-right' : 'text-left')}
    >
      <button
        type="button"
        onClick={() => {
          onChangeSort(columnKey);
        }}
        className={cn(
          'flex w-full items-center gap-1 p-2',
          align === 'end' ? 'justify-end' : 'justify-start',
          focusRing,
        )}
      >
        <Text variant="kicker" as="span">
          {label}
        </Text>
        <Icon icon={glyph} size="sm" />
      </button>
    </th>
  );
}

function DriveGrid(props: RowsProps): ReactNode {
  const {
    rows,
    fileInfo,
    selected,
    dropTargetRow,
    onOpen,
    onToggleSelect,
    onDragStart,
    onDragOver,
    onDragEnd,
    onDrop,
  } = props;

  return (
    // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind removes the list style, and with it this implicit role in WebKit.
    <ul
      role="list"
      aria-label="This drive's contents"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
    >
      {rows.map((item) => {
        const info = fileInfo.get(item.id);
        const RowIcon = driveKindIcon(item);
        const isSelected = selected.has(item.id);
        return (
          <li
            key={item.id}
            draggable
            onDragStart={(event) => {
              onDragStart(item, event);
            }}
            onDragOver={(event) => {
              onDragOver(item, event);
            }}
            onDragEnd={onDragEnd}
            onDrop={(event) => {
              onDrop(item, event);
            }}
            className={cn(
              blueprintFrame,
              'relative flex flex-col items-center gap-2 bg-surface p-3',
              isSelected && 'bg-accent/10',
              dropTargetRow === item.id && 'outline-2 -outline-offset-2 outline-accent',
            )}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onClick={(event) => {
                onToggleSelect(item.id, event.shiftKey);
              }}
              onChange={() => undefined}
              aria-label={`Select ${item.title || 'Untitled'}`}
              className={cn('self-start', focusRing)}
            />
            <Icon icon={RowIcon} size="lg" />
            <button
              type="button"
              onClick={() => {
                onOpen(item.id);
              }}
              className={cn('w-full text-center', focusRing)}
            >
              <Text variant="body" as="span">
                {item.title || 'Untitled'}
              </Text>
            </button>
            <Text variant="caption" as="span" tone="muted">
              {item.type === 'file'
                ? info?.status === 'ready'
                  ? formatBytes(info.record.current.byteLength)
                  : '—'
                : kindOf(item, info)}
            </Text>
          </li>
        );
      })}
    </ul>
  );
}
