import {
  petSettingsSchema,
  petProviderSchema,
  type PetProfile,
  type PetSettings,
  type PetSettingsResponse,
} from '@nix/api-client';
import { Button, Field, Input, Select, Text, Textarea } from '@nix/ui';
import { useState, type ReactElement } from 'react';
import { newPet, petCatalog, personalityDescriptions } from './catalog';
import { usePetSettings } from './use-pet-settings';
import { PetAvatar } from './pet-avatar';
import { PetConnectionPanel } from './pet-connection-panel';
import { PetProviderKeys } from './pet-provider-keys';
import { PetDeviceSettings } from './pet-device-settings';
import { PreferenceToggle } from '../settings/shared/preference-toggle';
import { SettingsSection } from '../settings/shared/settings-section';

export function PetSettingsSection(): ReactElement {
  const state = usePetSettings();
  return (
    <SettingsSection
      title="Your companions"
      summary="Pick a provider, character and tone; pets follow your account across workspaces"
    >
      {state.loading ? <Text role="status">Loading your pets…</Text> : null}
      {state.error ? (
        <div className="flex flex-col gap-2">
          <Text role="alert">{state.error}</Text>
          <Button variant="secondary" onClick={state.reload} disabled={state.saving}>
            Reload saved settings
          </Button>
        </div>
      ) : null}
      {state.saved ? (
        <PetSettingsEditor
          initial={state.saved}
          saving={state.saving || state.loading}
          onSave={state.save}
        />
      ) : null}
    </SettingsSection>
  );
}

interface EditorProps {
  readonly initial: PetSettingsResponse;
  readonly saving: boolean;
  readonly onSave: (settings: PetSettings) => Promise<boolean>;
}

export function PetSettingsEditor({ initial, saving, onSave }: EditorProps): ReactElement {
  const [previousInitial, setPreviousInitial] = useState(initial);
  const [draft, setDraft] = useState(initial.settings);
  const [selectedId, setSelectedId] = useState(
    initial.settings.activePetId ?? initial.settings.profiles[0]?.id ?? null,
  );
  const [message, setMessage] = useState<string | null>(null);
  if (initial !== previousInitial) {
    setPreviousInitial(initial);
    if (JSON.stringify(draft) !== JSON.stringify(initial.settings)) {
      setDraft(initial.settings);
      setSelectedId(
        initial.settings.profiles.some((profile) => profile.id === selectedId)
          ? selectedId
          : (initial.settings.activePetId ?? initial.settings.profiles[0]?.id ?? null),
      );
      setMessage(null);
    }
  }
  const pet = draft.profiles.find((profile) => profile.id === selectedId) ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.settings);

  function change(next: PetSettings): void {
    setDraft(next);
    setMessage(null);
  }
  function updatePet(update: Partial<PetProfile>): void {
    change({
      ...draft,
      profiles: draft.profiles.map((profile) =>
        profile.id === selectedId ? { ...profile, ...update } : profile,
      ),
    });
  }
  function add(profile: PetProfile): void {
    change({
      ...draft,
      activePetId: draft.activePetId ?? profile.id,
      profiles: [...draft.profiles, profile],
    });
    setSelectedId(profile.id);
  }
  function remove(): void {
    const profiles = draft.profiles.filter((profile) => profile.id !== selectedId);
    change({
      ...draft,
      profiles,
      enabled: profiles.length > 0 && draft.enabled,
      activePetId: draft.activePetId === selectedId ? (profiles[0]?.id ?? null) : draft.activePetId,
    });
    setSelectedId(profiles[0]?.id ?? null);
  }

  async function saveSettings(): Promise<boolean> {
    const parsed = petSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setMessage('Check the name and settings of each pet before saving.');
      return false;
    }
    if (!dirty) return true;
    const ok = await onSave(parsed.data);
    if (ok) {
      setDraft(parsed.data);
      setMessage('Pet settings saved.');
    }
    return ok;
  }

  return (
    <form
      className="@container flex min-w-0 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void saveSettings();
      }}
    >
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">Saved pets</legend>
        <PreferenceToggle
          label="Show companion in my workspaces"
          checked={draft.enabled}
          disabled={draft.activePetId === null}
          onChange={(enabled) => {
            change({ ...draft, enabled });
          }}
          description="Needs an active pet"
          unsaved={null}
        />
        <PreferenceToggle
          label="Use AI while writing notes"
          checked={draft.inlineWriting}
          disabled={draft.activePetId === null || !draft.enabled}
          onChange={(inlineWriting) => {
            change({ ...draft, inlineWriting });
          }}
          description="AI commands in the slash and selection menus"
          unsaved={null}
          more="The text you select is sent to your connected model. Locked notes are never sent."
        />
        <Text variant="h5" as="h3">
          Pets
        </Text>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={draft.profiles.length >= 12}
            onClick={() => {
              add(newPet());
            }}
          >
            Add pet
          </Button>
          {pet ? (
            <Button
              type="button"
              variant="ghost"
              disabled={draft.profiles.length >= 12}
              onClick={() => {
                add({ ...pet, id: crypto.randomUUID(), name: `${pet.name.slice(0, 75)} copy` });
              }}
            >
              Duplicate pet
            </Button>
          ) : null}
        </div>
        {draft.profiles.length === 0 ? (
          <Text variant="note" tone="muted">
            Add your first pet to choose its appearance and personality.
          </Text>
        ) : (
          <Field label="Saved pet">
            {(control) => (
              <Select
                {...control}
                value={selectedId ?? ''}
                onChange={(event) => {
                  setSelectedId(event.currentTarget.value);
                }}
              >
                {draft.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name || 'Unnamed pet'}
                    {profile.id === draft.activePetId ? ' (active)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {pet ? (
          <>
            <Field label="Model provider" hint="The service this pet uses for chat and writing">
              {(control) => (
                <Select
                  {...control}
                  value={pet.provider}
                  onChange={(event) => {
                    updatePet({ provider: petProviderSchema.parse(event.currentTarget.value) });
                  }}
                >
                  <option value="chatgpt">ChatGPT</option>
                  <option value="anthropic">Claude</option>
                  <option value="openrouter">OpenRouter</option>
                </Select>
              )}
            </Field>
            {pet.provider === 'chatgpt' ? (
              <PetConnectionPanel />
            ) : (
              <PetProviderKeys
                key={pet.provider}
                provider={pet.provider}
                onSaveSettings={saveSettings}
                needsProviderSave={
                  initial.settings.profiles.find((saved) => saved.id === pet.id)?.provider !==
                  pet.provider
                }
              />
            )}
            <Text variant="h5" as="h3">
              Look and voice
            </Text>
            <PetAvatar
              appearance={pet.appearance}
              motion={draft.motion}
              label={`${pet.name || 'Pet'} appearance preview`}
            />
            <Field label="Name">
              {(control) => (
                <Input
                  {...control}
                  required
                  maxLength={80}
                  value={pet.name}
                  onChange={(event) => {
                    updatePet({ name: event.currentTarget.value });
                  }}
                />
              )}
            </Field>
            <div className="grid min-w-0 gap-4 @lg:grid-cols-2">
              <Field label="Appearance">
                {(control) => (
                  <Select
                    {...control}
                    value={pet.appearance}
                    onChange={(event) => {
                      updatePet({
                        appearance: event.currentTarget.value as PetProfile['appearance'],
                      });
                    }}
                  >
                    {petCatalog.map((entry) => (
                      <option key={entry.appearance} value={entry.appearance}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Personality">
                {(control) => (
                  <Select
                    {...control}
                    value={pet.personality}
                    onChange={(event) => {
                      updatePet({
                        personality: event.currentTarget.value as PetProfile['personality'],
                      });
                    }}
                  >
                    <option value="calm">Calm and thoughtful</option>
                    <option value="playful">Playful and inventive</option>
                    <option value="encouraging">Encouraging and practical</option>
                    <option value="concise">Concise and composed</option>
                  </Select>
                )}
              </Field>
            </div>
            <Text variant="note" tone="muted">
              {personalityDescriptions[pet.personality]}
            </Text>
            <Field label="Response length">
              {(control) => (
                <Select
                  {...control}
                  value={pet.responseLength}
                  onChange={(event) => {
                    updatePet({
                      responseLength: event.currentTarget.value as PetProfile['responseLength'],
                    });
                  }}
                >
                  <option value="concise">Concise</option>
                  <option value="balanced">Balanced</option>
                  <option value="detailed">Detailed</option>
                </Select>
              )}
            </Field>
            <Field
              label="Personal instructions"
              hint="How you like to work; this never grants extra access"
            >
              {(control) => (
                <Textarea
                  {...control}
                  rows={4}
                  maxLength={2000}
                  value={pet.instructions}
                  onChange={(event) => {
                    updatePet({ instructions: event.currentTarget.value });
                  }}
                />
              )}
            </Field>
            <PreferenceToggle
              label="Apply changes without asking by default"
              checked={pet.applyWithoutAsking}
              onChange={(applyWithoutAsking) => {
                updatePet({ applyWithoutAsking });
              }}
              description="Clean changes run as soon as their preview shows no problems"
              unsaved={null}
              more="Starts each conversation with the Apply without asking switch on. Moves, trash, template saves and external links still ask, and you can turn the switch off in any conversation."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={pet.id === draft.activePetId}
                onClick={() => {
                  change({ ...draft, activePetId: pet.id });
                }}
              >
                Use this pet
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label="Remove pet from settings"
                onClick={remove}
              >
                Remove pet
              </Button>
            </div>
          </>
        ) : null}
        <Field label="Motion">
          {(control) => (
            <Select
              {...control}
              value={draft.motion}
              onChange={(event) => {
                change({ ...draft, motion: event.currentTarget.value as PetSettings['motion'] });
              }}
            >
              <option value="system">Follow system preference</option>
              <option value="reduced">Reduced</option>
              <option value="full">Full</option>
            </Select>
          )}
        </Field>
      </fieldset>
      {draft.enabled ? <PetDeviceSettings inlineWriting={draft.inlineWriting} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save pet settings'}
        </Button>
        {dirty ? (
          <Text variant="note" tone="muted">
            Unsaved changes
          </Text>
        ) : null}
      </div>
      {message ? (
        <Text role="status" variant="note">
          {message}
        </Text>
      ) : null}
    </form>
  );
}
