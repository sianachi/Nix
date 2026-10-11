import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { MobileNavigation } from './mobile-navigation';

export default { title: 'Nix/Shell/Mobile navigation', parameters: { layout: 'fullscreen' } };

const noop = (): void => undefined;

function Example({ creating = false }: { readonly creating?: boolean }): ReactNode {
  return (
    <MemoryRouter>
      <MobileNavigation
        workspaceId="story-workspace"
        treeOpen={false}
        creating={creating}
        unreadNotifications={2}
        petAttention="waiting for approval"
        onTree={noop}
        onSearch={noop}
        onCreate={noop}
        onOpenInbox={noop}
      />
    </MemoryRouter>
  );
}

export const Navigation = { render: (): ReactNode => <Example /> };
export const Creating = { render: (): ReactNode => <Example creating /> };
