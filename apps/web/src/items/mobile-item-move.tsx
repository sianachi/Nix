import { Button, Dialog, Text } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';
import { MobileDestinationPicker } from './mobile-destination-picker';
import type { WorkspaceTree } from './use-workspace-tree';

export function MobileItemMove({
  itemId,
  tree,
  onClose,
}: {
  readonly itemId: string;
  readonly tree: WorkspaceTree;
  readonly onClose: () => void;
}): ReactNode {
  const [parentId, setParentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  async function move(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await tree.move(itemId, parentId, null);
      if (result.refusal !== null) setError(result.refusal);
      else onClose();
    } catch {
      setError('The move could not be confirmed. Check the workspace before retrying.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      title="Move item"
      swipeToClose={!saving}
      onClose={() => {
        if (!pending.current) onClose();
      }}
      actions={
        <Button
          disabled={saving || parentId === tree.find(itemId)?.parentId}
          onClick={() => {
            void move();
          }}
        >
          {saving ? 'Moving…' : 'Move here'}
        </Button>
      }
    >
      <MobileDestinationPicker
        tree={tree}
        parentId={parentId}
        onChange={setParentId}
        disabled={saving}
        purpose="move"
        excludedId={itemId}
      />
      {error ? (
        <Text variant="note" role="alert">
          {error}
        </Text>
      ) : null}
    </Dialog>
  );
}
