import type { ReactElement } from 'react';
import { Text } from '@nix/ui';
import { PetAvatar, petAnimationStates } from './pet-avatar';
import { PetSettingsEditor } from './pet-settings-section';
import { PetWorkTools } from './pet-work-tools';
import { createNixClient, petConnectionSchema } from '@nix/api-client';
import { MemoryRouter } from 'react-router';
import { PetHistory } from './pet-history';
import { PetChatViewport } from './pet-chat-viewport';
import { PetMessageText } from './pet-message-text';

export default { title: 'Nix/Companions', parameters: { layout: 'padded' } };

export const AnimationStates = {
  render: (): ReactElement => (
    <div className="grid grid-cols-3 gap-4">
      {(['owl', 'cat', 'fox'] as const).flatMap((appearance) =>
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
