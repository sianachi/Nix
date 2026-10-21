import { Button, Field, Input } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import type { Administration, CurrentWorkspace } from './shared';

export function RenameForm(props: {
  readonly workspace: CurrentWorkspace;
  readonly administration: Administration;
}): ReactNode {
  const { workspace, administration } = props;
  const [name, setName] = useState(workspace.name);
  return (
    <form
      className="flex max-w-xl flex-col items-stretch gap-2 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        void administration.rename(name.trim());
      }}
    >
      <Field label="Workspace name" className="min-w-0 flex-1">
        {(control) => (
          <Input
            {...control}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="secondary"
        disabled={administration.working || name.trim().length === 0}
      >
        Rename
      </Button>
    </form>
  );
}
