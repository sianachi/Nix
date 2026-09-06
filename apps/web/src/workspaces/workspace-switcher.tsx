import { Icon, Text, focusRing } from '@nix/ui';
import { Check, ChevronDown, Plus, Settings } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useWorkspace } from './workspace-context';

/**
 * The workspace switcher is also the workspace index: every accessible workspace has a direct
 * route to its content and its management page. Switching always starts at a workspace root, so
 * neither an item nor a pane from one workspace can leak into another by way of the address bar.
 */
export function WorkspaceSwitcher(): ReactNode {
  const { workspace, workspaces, listStatus, listWarning, reload } = useWorkspace();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function closeOutside(event: MouseEvent): void {
      if (containerRef.current?.contains(event.target as Node) === false) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    }

    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative flex min-w-0 flex-1">
      <button
        type="button"
        aria-label={`Workspace: ${workspace.name}`}
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={`flex min-w-0 w-full items-center justify-between gap-2 border border-transparent px-2 py-1 text-left text-xs text-muted hover:bg-foreground/7 hover:text-foreground ${focusRing}`}
      >
        <span className="truncate">{workspace.name}</span>
        <Icon icon={ChevronDown} size="sm" />
      </button>

      {open ? (
        <section
          id={panelId}
          aria-label="Workspaces"
          className="absolute left-0 top-full z-20 mt-1 w-80 border border-divider bg-background shadow-md"
        >
          <div className="border-b border-divider px-3 py-2">
            <Text variant="bodySmall">Workspaces</Text>
            <Text variant="caption" as="p" tone="muted">
              Open a workspace or manage its people and settings.
            </Text>
          </div>

          <ul aria-label="Your workspaces" className="max-h-72 overflow-y-auto py-1">
            {workspaces.map((entry) => (
              <li key={entry.id} className="flex items-center gap-1 px-1">
                <Link
                  to={`/w/${entry.id}`}
                  aria-current={entry.id === workspace.id ? 'page' : undefined}
                  onClick={() => {
                    setOpen(false);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-sm text-foreground no-underline hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <Icon
                    icon={Check}
                    size="sm"
                    className={entry.id === workspace.id ? 'text-accent-text' : 'invisible'}
                  />
                  <span className="truncate">{entry.name}</span>
                </Link>
                <Link
                  to={`/w/${entry.id}/settings`}
                  aria-label={`Manage ${entry.name}`}
                  onClick={() => {
                    setOpen(false);
                  }}
                  className="flex size-(--control-sm) shrink-0 items-center justify-center text-muted no-underline hover:bg-accent/10 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <Icon icon={Settings} size="sm" />
                </Link>
              </li>
            ))}
          </ul>

          {listStatus === 'partial' ? (
            <div className="border-t border-divider px-3 py-2">
              <Text variant="caption" as="p" tone="muted" role="status">
                {listWarning ?? 'Some workspaces could not be loaded.'}
              </Text>
              <button
                type="button"
                onClick={reload}
                className={`mt-1 text-xs text-accent-text underline ${focusRing}`}
              >
                Try again
              </button>
            </div>
          ) : null}

          <Link
            to={`/w/${workspace.id}/settings`}
            onClick={() => {
              setOpen(false);
            }}
            className="flex items-center gap-2 border-t border-divider px-3 py-2 text-sm text-foreground no-underline hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <Icon icon={Plus} size="sm" />
            Create a workspace
          </Link>
        </section>
      ) : null}
    </div>
  );
}
