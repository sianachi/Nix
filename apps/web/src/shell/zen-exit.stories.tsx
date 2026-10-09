import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { ZenExit } from './zen-exit';

export default { title: 'Nix/Shell/Zen', parameters: { layout: 'fullscreen' } };

function Example(): ReactNode {
  return (
    <div className="min-h-dvh bg-background px-3 py-3 text-foreground sm:px-5">
      <ZenExit />
      <div className="mx-auto max-w-prose pr-12">
        <Text variant="h4" className="mb-4">
          An evening walk
        </Text>
        <Text variant="body">The day settles into the trees.</Text>
        <Text variant="body">I leave room for another thought.</Text>
      </div>
    </div>
  );
}

export const ContentFocus = { render: (): ReactNode => <Example /> };
export const DarkContentFocus = { ...ContentFocus, globals: { ground: 'dark' } };
