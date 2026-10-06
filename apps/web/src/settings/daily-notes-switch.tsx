import { Blueprint, Checkbox, Text, focusRing } from '@nix/ui';
import { useId, useState, type ReactElement } from 'react';
import { Link } from 'react-router';

import { useWorkspace } from '../workspaces/workspace-context';
import { useDailyNoteSettings } from './use-daily-note-settings';

/**
 * Daily notes on or off for the current workspace, offered where workspaces are managed.
 *
 * **The same switch as the Daily notes tab, not a second one.** It loads and saves through the same
 * hook, so the permission rule, the refusal and the refresh of the workspace list are the tab's;
 * a save writes back the whole settings document as loaded with only `enabled` changed. The
 * detailed options stay on the tab, which this links to.
 */
export function DailyNotesSwitch(): ReactElement {
  const { workspaceId, workspace } = useWorkspace();
  const state = useDailyNoteSettings(workspaceId);
  // The rule the Daily notes tab uses: `canRename` is the server's "owner or tenant admin" flag.
  const canManage = workspace.canRename && !state.forbidden;
  const [message, setMessage] = useState<string | null>(null);
  const hintId = useId();
  const { saved } = state;

  return (
    <Blueprint className="flex max-w-xl flex-col gap-3 p-4">
      <Text variant="h4" as="h3">
        Daily notes
      </Text>
      {state.loading && saved === null ? (
        <Text role="status" variant="note" tone="muted">
          Loading daily note settings…
        </Text>
      ) : null}
      {saved === null ? null : (
        <div className="flex flex-col gap-1">
          <Checkbox
            label="Use daily notes in this workspace"
            aria-describedby={hintId}
            checked={saved.enabled}
            disabled={!canManage || state.saving || state.loading}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setMessage(null);
              void state.save({ ...saved, enabled }).then((ok) => {
                if (ok) {
                  setMessage(
                    enabled
                      ? 'Daily notes are on for this workspace.'
                      : 'Daily notes are off for this workspace.',
                  );
                }
              });
            }}
          />
          <Text id={hintId} variant="note" tone="muted">
            One note per day for the whole workspace. Switching them off keeps every existing daily
            note as an ordinary note.
          </Text>
        </div>
      )}
      {saved !== null && !canManage ? (
        <Text variant="note">
          Only a workspace owner or an administrator can switch daily notes on or off.
        </Text>
      ) : null}
      {state.error === null ? null : (
        <Text role="alert" variant="note">
          {state.error}
        </Text>
      )}
      {message === null ? null : (
        <Text role="status" variant="note">
          {message}
        </Text>
      )}
      <Link
        to={`/w/${workspaceId}/settings?tab=daily-notes`}
        className={`${focusRing} self-start underline`}
      >
        <Text variant="note" as="span">
          Folders, titles and the template are in Daily notes settings
        </Text>
      </Link>
    </Blueprint>
  );
}
