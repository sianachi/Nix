import { Button, Icon, cn } from '@nix/ui';
import { Minimize2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { quietTopControl, useNearTopEdge } from '../lib/use-near-top-edge';
import { setZenMode } from '../lib/zen-mode';

/**
 * The way out of Zen: small, quiet, and always there for whoever goes looking.
 *
 * Fixed to the top-right of the window and invisible until the pointer nears the top edge or it
 * is focused; it is the first thing Tab reaches while Zen is on (the shell mounts it before
 * anything else, in place of the skip link, which has no chrome left to skip). `z-20` clears pane
 * content and stays under the dialogs' `z-30`, so a modal that is open is not left with a live
 * control above it.
 */
export function ZenExit(): ReactNode {
  const near = useNearTopEdge();
  return (
    <Button
      variant="icon"
      aria-label="Exit Zen mode"
      title="Exit Zen mode"
      onClick={() => {
        setZenMode(false);
      }}
      // design-token-exempt: inset from the window corner, clear of the device safe area.
      className={cn(
        'fixed right-3 top-[calc(env(safe-area-inset-top)+var(--spacing)*3)] z-20 bg-background',
        quietTopControl(near),
      )}
    >
      <Icon icon={Minimize2} size="sm" />
    </Button>
  );
}
