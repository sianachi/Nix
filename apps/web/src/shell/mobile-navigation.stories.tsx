import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { MobileNavigation } from './mobile-navigation';

export default { title: 'Nix/Shell/Mobile navigation', parameters: { layout: 'fullscreen' } };

const noop = (): void => undefined;

function Example({
  creating = false,
  withPet = true,
}: {
  readonly creating?: boolean;
  readonly withPet?: boolean;
}): ReactNode {
  return (
    <MemoryRouter>
      <MobileNavigation
        workspaceId="story-workspace"
        treeOpen={false}
        creating={creating}
        unreadNotifications={2}
        pet={withPet ? { label: 'Cat', attention: 'needs approval' } : null}
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
export const WithoutPet = { render: (): ReactNode => <Example withPet={false} /> };
