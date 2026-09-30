import { Button, Text } from '@nix/ui';
import type { ReactNode } from 'react';

/** The notice code `collab-sync` reports when the copy painted on open is not this document's. */
export const LOCAL_COPY_STALE = 'local_copy_stale';

/**
 * What a document says when the copy this device painted belongs to a different version of it
 * than the one the server now has. Syncing has stopped - it would mix the two - so the body is
 * made read-only by its editor and this offers the one way forward. A button rather than "reload
 * the page": an installed app's window has no reload control of its own.
 */
export function StaleCopyNotice({ noun }: { readonly noun: string }): ReactNode {
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-3 bg-background px-8 py-1.5"
    >
      <Text variant="caption" as="p" tone="accent">
        This {noun} changed while you were away, and what is showing is this device’s older copy.
        Changes here are not saved.
      </Text>
      <Button
        variant="secondary"
        onClick={() => {
          globalThis.location.reload();
        }}
      >
        Reload
      </Button>
    </div>
  );
}
