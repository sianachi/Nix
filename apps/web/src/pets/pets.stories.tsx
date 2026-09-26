import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { Text } from '@nix/ui';
import { petCatalog } from './catalog';
import { PetAvatar, petAnimationStates, type PetAnimationState } from './pet-avatar';
import type { NixClient, PetProfile, Workspace } from '@nix/api-client';
import { PetSettingsEditor } from './pet-settings-section';
import { PetWorkTools } from './pet-work-tools';
import { createNixClient, petConnectionSchema } from '@nix/api-client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ApiClientOverrideProvider } from '../api/api-client-provider';
import { WorkspaceProvider, type WorkspaceLoadState } from '../workspaces/workspace-context';
import { PetCompanion } from './pet-companion';
import { PetHistory } from './pet-history';
import { PetChatViewport } from './pet-chat-viewport';
import { PetMessageText } from './pet-message-text';
import { PetStructurePreview } from './pet-structure-preview';
import type { PreviewModel } from '@nix/structure-spec';

export default { title: 'Nix/Companions', parameters: { layout: 'padded' } };

export const AnimationStates = {
  render: (): ReactElement => (
    <div className="grid grid-cols-3 gap-4">
      {petCatalog.flatMap(({ appearance }) =>
        petAnimationStates.map((state) => (
          <div key={`${appearance}:${state}`} className="flex flex-col items-center gap-2">
            <PetAvatar
              appearance={appearance}
              state={state}
              motion="reduced"
              label={`${appearance}: ${state}`}
            />
            <Text variant="note">
              {appearance}: {state}
            </Text>
          </div>
        )),
      )}
    </div>
  ),
};

export const Settings = {
  render: (): ReactElement => (
    <PetSettingsEditor
      initial={{
        revision: 1,
        settings: {
          enabled: true,
          activePetId: '44444444-4444-4444-8444-444444444444',
          motion: 'reduced',
          narration: false,
          profiles: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              name: 'Pip',
              appearance: 'cat',
              personality: 'calm',
              responseLength: 'balanced',
              instructions: '',
            },
          ],
        },
      }}
      saving={false}
      onSave={() => Promise.resolve(true)}
    />
  ),
};

export const DarkSettings = { ...Settings, globals: { ground: 'dark' } };
export const DarkAnimationStates = { ...AnimationStates, globals: { ground: 'dark' } };

export const AnimatedCompanion = {
  args: { appearance: 'demiurge' as PetProfile['appearance'], state: 'idle' as PetAnimationState },
  argTypes: {
    appearance: { control: 'select', options: petCatalog.map((pet) => pet.appearance) },
    state: { control: 'select', options: petAnimationStates },
  },
  render: ({
    appearance,
    state,
  }: {
    appearance: PetProfile['appearance'];
    state: PetAnimationState;
  }): ReactElement => (
    <PetAvatar
      appearance={appearance}
      state={state}
      motion="full"
      label={`${appearance}: ${state}`}
    />
  ),
};

const previewClient = createNixClient({
  baseUrl: 'http://nix.invalid',
  tokens: {
    getAccessToken: () => Promise.resolve(null),
    refreshAccessToken: () => Promise.resolve(null),
  },
});
export const WorkApproval = {
  render: (): ReactElement => (
    <MemoryRouter>
      <PetWorkTools
        client={previewClient}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={() => undefined}
        runtime={petConnectionSchema.parse({
          provider: 'chatgpt',
          status: 'connected',
          reason: '',
          canConnect: false,
          tools: [
            {
              id: 'preview',
              arguments: JSON.stringify({
                operation: 'create_note',
                itemId: '',
                parentId: '',
                title: 'Weekly plan',
                markdown: '# Weekly plan\n\n- Review priorities\n- Draft the release notes',
                query: '',
                propertiesJson: '',
              }),
              status: 'pending',
              result: '',
              claimId: '',
            },
          ],
        })}
      />
    </MemoryRouter>
  ),
};
export const DarkWorkApproval = { ...WorkApproval, globals: { ground: 'dark' } };

const structurePreviewModel: PreviewModel = {
  headline: 'I will create a Reading log with a board view.',
  destination: { title: 'Books', path: ['Books'] },
  counts: { items: 3, fields: 7, views: 2, entries: 0, writes: 12 },
  tree: [
    {
      label: 'Reading log',
      detail: ['Board view grouped by Status'],
      why: 'Keep the books you are reading together.',
      children: [
        {
          label: 'Fields',
          detail: [],
          children: [
            { label: 'Rating (number)', detail: [], children: [] },
            { label: 'Finished on (date)', detail: [], children: [] },
            { label: 'Status (select)', detail: [], children: [] },
          ],
        },
        { label: 'Board view', detail: ['Grouped by Status'], children: [] },
      ],
    },
  ],
  notes: [],
  warnings: [],
  problems: [],
  neverDoes: ['Publish a public link', 'Delete anything permanently', 'Remove or retype a field'],
};

export const StructureApproval = {
  render: (): ReactElement => <PetStructurePreview model={structurePreviewModel} />,
};
export const DarkStructureApproval = { ...StructureApproval, globals: { ground: 'dark' } };

const entriesPreviewModel: PreviewModel = {
  ...structurePreviewModel,
  headline: 'I will add 3 entries to Reading log.',
  counts: { items: 0, fields: 3, views: 0, entries: 3, writes: 3 },
  tree: [
    {
      label: 'Entries',
      detail: [],
      children: [
        { label: 'The Left Hand of Darkness', detail: ['Status: To read'], children: [] },
        { label: 'Kindred', detail: ['Status: Reading'], children: [] },
        { label: 'Piranesi', detail: ['Status: Finished'], children: [] },
      ],
    },
  ],
};
export const EntriesApproval = {
  render: (): ReactElement => <PetStructurePreview model={entriesPreviewModel} />,
};
export const DarkEntriesApproval = { ...EntriesApproval, globals: { ground: 'dark' } };

const problemsPreviewModel: PreviewModel = {
  ...structurePreviewModel,
  headline: 'I cannot run this request as written.',
  tree: [],
  problems: [
    {
      path: 'views[0].groupBy',
      code: 'unknown_field',
      message: 'Status is not in the current schema.',
    },
  ],
};
export const ProblemsApproval = {
  render: (): ReactElement => <PetStructurePreview model={problemsPreviewModel} />,
};
export const DarkProblemsApproval = { ...ProblemsApproval, globals: { ground: 'dark' } };

const structureWorkClient = {
  query: (endpoint: { operation: string }): Promise<unknown> => {
    if (endpoint.operation === 'items.get')
      return Promise.resolve({
        id: '33333333-3333-4333-8333-333333333333',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        parentId: null,
        title: 'Reading log',
        properties: {},
      });
    if (endpoint.operation === 'schema.get')
      return Promise.resolve({ properties: [], declared: [], inherit: true });
    if (endpoint.operation === 'views.getConfigurations') return Promise.resolve({ views: [] });
    return Promise.reject(new Error(`Unexpected preview read: ${endpoint.operation}`));
  },
  invalidate: () => undefined,
} as unknown as NixClient;

export const StructureWorkApproval = {
  render: (): ReactElement => (
    <MemoryRouter>
      <PetWorkTools
        client={structureWorkClient}
        workspaceId="11111111-1111-4111-8111-111111111111"
        petId="22222222-2222-4222-8222-222222222222"
        onChange={() => undefined}
        runtime={petConnectionSchema.parse({
          provider: 'chatgpt',
          status: 'connected',
          reason: '',
          canConnect: false,
          tools: [
            {
              id: 'structure-preview',
              arguments: JSON.stringify({
                operation: 'add_fields',
                itemId: '33333333-3333-4333-8333-333333333333',
                parentId: '',
                title: '',
                markdown: '',
                query: '',
                propertiesJson: '',
                specJson: JSON.stringify({ fields: [{ label: 'Rating', type: 'number' }] }),
              }),
              status: 'pending',
              result: '',
              claimId: '',
            },
          ],
        })}
      />
    </MemoryRouter>
  ),
};

export const History = {
  render: (): ReactElement => (
    <PetHistory
      client={previewClient}
      workspaceId="11111111-1111-4111-8111-111111111111"
      petId="22222222-2222-4222-8222-222222222222"
      name="Pip"
    />
  ),
};

export const LongReply = {
  render: (): ReactElement => (
    <div className="flex h-128 w-128 max-w-full flex-col overflow-hidden rounded-lg border border-divider bg-background">
      <div className="shrink-0 border-b border-divider p-3">
        <Text variant="h3">Pip</Text>
      </div>
      <PetChatViewport latestKey="reply">
        <Text variant="note" tone="muted">
          You
        </Text>
        <Text>How should I organise the release notes?</Text>
        <div data-pet-latest-message="" className="flex shrink-0 flex-col gap-3">
          <Text variant="note" tone="muted">
            Pip
          </Text>
          {Array.from({ length: 6 }, (_, index) => (
            <Text key={index}>
              Keep the release overview short, then group the details by what changed for the
              reader. Put new features first, followed by improvements and fixes. Include links to
              the notes that explain each change.
            </Text>
          ))}
        </div>
      </PetChatViewport>
      <div className="shrink-0 border-t border-divider p-3">
        <Text variant="note">The message composer stays visible while reading.</Text>
      </div>
    </div>
  ),
};
export const DarkLongReply = { ...LongReply, globals: { ground: 'dark' } };

export const ResultLinks = {
  render: (): ReactElement => (
    <MemoryRouter>
      <PetMessageText
        workspaceId="11111111-1111-4111-8111-111111111111"
        text="Created [Release plan](/w/11111111-1111-4111-8111-111111111111?item=22222222-2222-4222-8222-222222222222). Review the draft before publishing."
      />
    </MemoryRouter>
  ),
};
export const DarkResultLinks = { ...ResultLinks, globals: { ground: 'dark' } };

const PHONE_WORKSPACE = '55555555-5555-4555-8555-555555555555';

const phoneWorkspace = {
  id: PHONE_WORKSPACE,
  name: 'Northstar',
  versionRetentionDays: 90,
  storageQuotaBytes: '10737418240',
  createdAt: '2026-09-01T09:00:00Z',
  kind: 'team',
  canRename: true,
  canManageMembers: true,
  canLeave: true,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
} as unknown as Workspace;

const phoneWorkspaceState = {
  status: 'ready',
  workspaces: [phoneWorkspace],
  error: null,
  reload: () => undefined,
  workspaceCreated: () => undefined,
  workspaceUpdated: () => undefined,
  workspaceRemoved: () => undefined,
} as WorkspaceLoadState & {
  readonly reload: () => void;
  readonly workspaceCreated: (workspace: Workspace) => void;
  readonly workspaceUpdated: (workspace: Workspace) => void;
  readonly workspaceRemoved: (workspaceId: string) => void;
};

const phoneSettings = {
  revision: 1,
  settings: {
    enabled: true,
    activePetId: '44444444-4444-4444-8444-444444444444',
    motion: 'reduced' as const,
    narration: false,
    profiles: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Pip',
        appearance: 'cat' as const,
        personality: 'calm' as const,
        responseLength: 'balanced' as const,
        instructions: '',
      },
    ],
  },
};

const phoneConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  state: 'success',
  messages: [
    {
      id: 'reply',
      role: 'assistant',
      text: 'Ready when you are. Ask me to find a note or plan your day.',
      actions: [],
    },
  ],
  verificationUrl: '',
  userCode: '',
});

const phoneClient = {
  ...createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }),
  query: () => Promise.resolve(phoneSettings),
  execute: () => Promise.resolve(phoneConnection),
} as NixClient;

/**
 * Stubs `matchMedia` to answer narrow (below the 640px phone breakpoint) so the two stories
 * below render their phone layout, and restores the previous implementation when the story
 * unmounts rather than leaking it into whichever story renders next.
 */
function stubNarrowMatchMedia(): () => void {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) =>
    ({
      matches: !query.includes('640'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
  return () => {
    window.matchMedia = original;
  };
}

/**
 * A 390x844 frame for the two phone stories below. `transform` on this box gives every
 * `position: fixed` descendant it, rather than the Storybook canvas, as its containing block
 * (CSS Transforms), which is what keeps the companion's fixed launcher and full-screen dialog
 * inside the simulated device rather than pinned to the whole preview iframe. `matchMedia` is
 * stubbed narrow synchronously, during this render, guarded by a ref so it runs once - so the
 * companion tree's own first render already sees the phone layout rather than painting wide and
 * then jumping.
 */
function PhoneFrame({ children }: { readonly children: ReactNode }): ReactElement {
  const restore = useRef<(() => void) | null>(null);
  restore.current ??= stubNarrowMatchMedia();
  useEffect(
    () => () => {
      restore.current?.();
      restore.current = null;
    },
    [],
  );
  return (
    <div
      style={{ width: 390, height: 844, transform: 'translateZ(0)' }} // design-token-exempt: simulates a fixed device viewport for a story.
      className="relative overflow-hidden rounded-lg border border-divider"
    >
      <MemoryRouter initialEntries={[`/w/${PHONE_WORKSPACE}`]}>
        <Routes>
          <Route
            path="/w/:workspaceId"
            element={
              <ApiClientOverrideProvider client={phoneClient}>
                <WorkspaceProvider state={phoneWorkspaceState}>{children}</WorkspaceProvider>
              </ApiClientOverrideProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </div>
  );
}

export const CompanionPhone = {
  render: (): ReactElement => (
    <PhoneFrame>
      <PetCompanion />
    </PhoneFrame>
  ),
};
export const DarkCompanionPhone = { ...CompanionPhone, globals: { ground: 'dark' } };

/**
 * Opens the launcher with a native click (no test-only dependency) so `ConversationPhone` below
 * can show the full-screen dialog without a play function. The launcher only exists once
 * `usePetSettings` has resolved, so a `MutationObserver` waits for it rather than clicking on
 * the empty first render.
 */
function AutoOpenCompanion(): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const clickWhenReady = (): boolean => {
      const button = node.querySelector<HTMLButtonElement>('button[aria-label^="Talk with "]');
      if (!button) return false;
      button.click();
      return true;
    };
    if (clickWhenReady()) return;
    const observer = new MutationObserver(() => {
      if (clickWhenReady()) observer.disconnect();
    });
    observer.observe(node, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <div ref={container}>
      <PetCompanion />
    </div>
  );
}

export const ConversationPhone = {
  render: (): ReactElement => (
    <PhoneFrame>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
};
export const DarkConversationPhone = { ...ConversationPhone, globals: { ground: 'dark' } };
