import {
  petSettingsSchema,
  type PetProfile,
  type PetSettings,
  type PetSettingsResponse,
} from '@nix/api-client';
import { Button, Field, Input, Select, Text, focusRing } from '@nix/ui';
import { useState, type ReactElement } from 'react';
import { newPet, petCatalog, personalityDescriptions } from './catalog';
import { usePetSettings } from './use-pet-settings';
import { PetAvatar } from './pet-avatar';

export function PetSettingsSection(): ReactElement {
  const state = usePetSettings();
  return (
    <section aria-labelledby="pets-heading" className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Text id="pets-heading" variant="h3" as="h2">
          Your companions
        </Text>
        <Text variant="note" tone="muted">
          Choose a character and a way of talking. Your pets belong to your account, across all your
          workspaces.
        </Text>
      </div>
      {state.loading ? <Text role="status">Loading your pets…</Text> : null}
      {state.error ? (
        <div className="flex flex-col gap-2">
          <Text role="alert">{state.error}</Text>
          <Button variant="secondary" onClick={state.reload} disabled={state.saving}>
            Reload saved settings
          </Button>
        </div>
      ) : null}
      {state.connection ? (
        <div className="flex flex-col gap-2 border border-divider p-3">
          <Text variant="h3" as="h3">
            ChatGPT
          </Text>
          <Text variant="note" tone="muted">
            {state.connection.reason}
          </Text>
          <Button variant="secondary" disabled>
            Connect ChatGPT
          </Button>
        </div>
      ) : null}
      {!state.loading && state.saved ? (
        <PetSettingsEditor initial={state.saved} saving={state.saving} onSave={state.save} />
      ) : null}
    </section>
  );
}

interface EditorProps {
  readonly initial: PetSettingsResponse;
  readonly saving: boolean;
  readonly onSave: (settings: PetSettings) => Promise<boolean>;
}

export function PetSettingsEditor({ initial, saving, onSave }: EditorProps): ReactElement {
  const [draft, setDraft] = useState(initial.settings);
  const [selectedId, setSelectedId] = useState(
    initial.settings.activePetId ?? initial.settings.profiles[0]?.id ?? null,
  );
  const [message, setMessage] = useState<string | null>(null);
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

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = petSettingsSchema.safeParse(draft);
        if (!parsed.success) {
          setMessage('Check the name and settings of each pet before saving.');
          return;
        }
        void onSave(parsed.data).then((ok) => {
          if (ok) {
            setDraft(parsed.data);
            setMessage('Pet settings saved.');
          }
        });
      }}
    >
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">Saved pets</legend>
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
            <PetAvatar motion={draft.motion} label={`${pet.name || 'Owl'} appearance preview`} />
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
            <div className="grid gap-4 sm:grid-cols-2">
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
              {personalityDescriptions[pet.personality]} All personalities have the same
              capabilities and respect your permissions.
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
              hint="Tell your pet how you like to work. These preferences do not grant additional access."
            >
              {(control) => (
                <textarea
                  {...control}
                  rows={4}
                  maxLength={2000}
                  value={pet.instructions}
                  className={`w-full border border-divider bg-background p-3 text-foreground ${focusRing}`}
                  onChange={(event) => {
                    updatePet({ instructions: event.currentTarget.value });
                  }}
                />
              )}
            </Field>
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
              <Button type="button" variant="ghost" onClick={remove}>
                Remove pet from settings
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
        <Text variant="note" tone="muted">
          The companion and voice controls will become available when ChatGPT is connected. Saved
          settings do not start an AI session.
        </Text>
      </fieldset>
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
