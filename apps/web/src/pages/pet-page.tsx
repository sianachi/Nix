import { type PetProfile, type PetSettings } from '@nix/api-client';
import { Text, focusRing } from '@nix/ui';
import { useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';

import { EmptyPanel, ErrorPanel, LoadingPanel } from '../components/states/status-panels';
import { paneColumn } from '../layout/regions';
import { type PetConversationMode } from '../pets/device-preferences';
import { Conversation } from '../pets/pet-conversation';
import { usePetRuntime } from '../pets/use-pet-runtime';
import { usePetSettings } from '../pets/use-pet-settings';
import { useWorkspace } from '../workspaces/workspace-context';

// On this page nothing sits behind a launcher, so there is no badge for a decision to set.
function ignoreDecisions(): void {
  /* Approvals are shown inside the conversation itself. */
}

/**
 * The pet destination: the same conversation as the floating panel, given the whole pane.
 *
 * The conversation lives on the server, so this is not a second chat but a second place to see
 * the one that exists. `PetCompanion` renders nothing while this route is current, which is what
 * keeps a single runtime (and a single `PetWorkTools`) alive at a time.
 */
export function PetPage(): ReactElement {
  const { workspaceId } = useWorkspace();
  const { saved, loading, error } = usePetSettings();
  const pet = saved?.settings.profiles.find((profile) => profile.id === saved.settings.activePetId);
  if (!saved) {
    return error ? (
      <ErrorPanel title="The companion could not be loaded" detail={error} />
    ) : (
      <LoadingPanel label={loading ? 'the companion' : 'the companion settings'} />
    );
  }
  if (!saved.settings.enabled || !pet) {
    return (
      <EmptyPanel
        title="The companion is switched off"
        detail="Turn it on in Settings to chat with it here."
        action={
          <Link to={`/w/${workspaceId}/settings`} className={`underline ${focusRing}`}>
            <Text as="span">Open Settings</Text>
          </Link>
        }
      />
    );
  }
  return (
    <PetConversationPane
      key={`${workspaceId}:${pet.id}`}
      workspaceId={workspaceId}
      pet={pet}
      settings={saved.settings}
    />
  );
}

function PetConversationPane({
  workspaceId,
  pet,
  settings,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
}): ReactElement {
  const [search] = useSearchParams();
  const [mode, setMode] = useState<PetConversationMode>(
    search.get('pet') === 'design' ? 'consult' : 'chat',
  );
  const runtimeApi = usePetRuntime(workspaceId, pet.id, mode, true);
  return (
    <div className={paneColumn}>
      <Text variant="h1" as="h1" className="sr-only">
        {pet.name}
      </Text>
      <Conversation
        workspaceId={workspaceId}
        pet={pet}
        settings={settings}
        mode={mode}
        onModeChange={setMode}
        layout="page"
        runtimeApi={runtimeApi}
        onNeedsDecisionChange={ignoreDecisions}
      />
    </div>
  );
}
