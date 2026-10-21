import { Button, Icon, Text } from '@nix/ui';
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  IndentDecrease,
  IndentIncrease,
  Plus,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { titleOf, type OutlineRow } from './outline-model';

interface OutlineToolbarProps {
  readonly row: OutlineRow | null;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onAdd: () => void;
  readonly onIndent: () => void;
  readonly onOutdent: () => void;
  readonly onUp: () => void;
  readonly onDown: () => void;
}

/** The structural edits as buttons, acting on the row last focused - a phone has no Tab key. */
export function OutlineToolbar(props: OutlineToolbarProps): ReactNode {
  const { row, busy, onOpen, onAdd, onIndent, onOutdent, onUp, onDown } = props;
  const name = row === null ? '' : ` "${titleOf(row.item)}"`;
  const disabled = row === null || busy;
  return (
    <div role="group" aria-label="Outline actions" className="flex flex-wrap items-center gap-1">
      <Button variant="ghost" onClick={onOpen} disabled={row === null}>
        <Icon icon={ExternalLink} size="sm" />
        Open
      </Button>
      <Button variant="ghost" onClick={onAdd} disabled={busy}>
        <Icon icon={Plus} size="sm" />
        Add item
      </Button>
      <Button variant="icon" aria-label={`Indent${name}`} onClick={onIndent} disabled={disabled}>
        <Icon icon={IndentIncrease} size="sm" />
      </Button>
      <Button variant="icon" aria-label={`Outdent${name}`} onClick={onOutdent} disabled={disabled}>
        <Icon icon={IndentDecrease} size="sm" />
      </Button>
      <Button variant="icon" aria-label={`Move${name} up`} onClick={onUp} disabled={disabled}>
        <Icon icon={ArrowUp} size="sm" />
      </Button>
      <Button variant="icon" aria-label={`Move${name} down`} onClick={onDown} disabled={disabled}>
        <Icon icon={ArrowDown} size="sm" />
      </Button>
      {/* Which row the buttons act on, said where they are: the highlight alone is easy to lose. */}
      <Text as="span" variant="caption" tone="muted" truncate className="min-w-0">
        {busy ? 'Saving…' : row === null ? 'No row chosen' : `Acting on “${titleOf(row.item)}”`}
      </Text>
    </div>
  );
}
