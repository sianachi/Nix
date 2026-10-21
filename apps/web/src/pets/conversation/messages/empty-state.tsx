import { Button, Text } from '@nix/ui';
import { type ReactElement } from 'react';

export function PetEmptyState({
  petName,
  workspaceAccess,
  suggestions,
  onPick,
}: {
  readonly petName: string;
  readonly workspaceAccess: boolean;
  readonly suggestions: readonly string[];
  readonly onPick: (suggestion: string) => void;
}): ReactElement {
  // Must-fix 13: the chat copy points at "Workspace access" only while it is still off - once
  // it is on, the paragraph would just be describing a control the person already turned on.
  const copy = workspaceAccess
    ? ''
    : `Ask a question. Turn on Workspace access below to let ${petName} find and change your notes, or design something new to keep track of.`;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      {copy ? (
        <Text variant="note" tone="muted">
          {copy}
        </Text>
      ) : null}
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            variant="secondary"
            onClick={() => {
              onPick(suggestion);
            }}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}

// Must-fix 5: "Add a status field to this list" only makes sense with an item open; "Summarize
// this page" the same.
export function petSuggestions(hasItem: boolean): readonly string[] {
  return hasItem
    ? [
        'Summarize this page',
        'Turn this note into sensible Nix views',
        'Write a note from these views',
        'Find my notes about...',
        'Add a status field to this list',
      ]
    : ['Find my notes about...', 'Plan my reading', 'Track a job hunt'];
}
