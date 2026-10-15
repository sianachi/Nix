import {
  conversations,
  items,
  pets,
  type Item,
  type PetProfile,
  type CreateConversationInput,
  type Conversation,
} from '@nix/api-client';
import { Button, Checkbox, Dialog, Field, Icon, Input, Select, Text } from '@nix/ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useWorkspaceArrangement } from '../../workspaces/use-workspace-arrangement';
import { PetMessageText } from '../../pets/pet-message-text';
import { Link, useNavigate } from 'react-router';
import { useApiClient } from '../../api/api-client-provider';
import { useAccessibleWorkspaces, useOptionalWorkspace } from '../../workspaces/workspace-context';
import { readLastWorkspaceId } from '../../workspaces/last-workspace';

export function ChatDestination({
  workspaceId,
  parentId,
  onChange,
}: {
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly onChange: (id: string | null) => void;
}): ReactNode {
  const client = useApiClient();
  const [choices, setChoices] = useState<readonly Item[]>([]);
  const [parentTitle, setParentTitle] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setError('');
        setChoices([]);
      }
    });
    if (!workspaceId)
      return () => {
        controller.abort();
      };
    void (async () => {
      if (parentId) {
        const parent = await client.query(items.itemById(parentId), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (parent.workspaceId !== workspaceId)
          throw new Error('Destination belongs to another workspace.');
        if (!controller.signal.aborted) setParentTitle(parent.title || 'Untitled note');
      }
      const found: Item[] = [];
      for await (const page of client.paginate(
        items.listItems(workspaceId, parentId ? { parentId } : {}),
        { signal: controller.signal },
      ))
        found.push(page);
      if (!controller.signal.aborted) setChoices(found);
    })().catch(() => {
      if (!controller.signal.aborted) setError('Destination notes could not be loaded.');
    });
    return () => {
      controller.abort();
    };
  }, [client, workspaceId, parentId]);
  return (
    <div className="flex flex-col gap-2">
      <Text variant="note">
        {parentId
          ? `Save inside ${parentTitle || 'the selected note'}. Choose a child to navigate further.`
          : 'Save at the workspace root, or choose a parent note.'}
      </Text>
      {parentId ? (
        <Button
          variant="secondary"
          onClick={() => {
            onChange(null);
          }}
        >
          Use workspace root
        </Button>
      ) : null}
      <Select
        aria-label="Destination parent note"
        value=""
        onChange={(event) => {
          if (event.currentTarget.value) onChange(event.currentTarget.value);
        }}
      >
        <option value="">{parentId ? parentTitle || 'Selected note' : 'Workspace root'}</option>
        {choices.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title || 'Untitled note'}
          </option>
        ))}
      </Select>
      {error ? <Text role="alert">{error}</Text> : null}
    </div>
  );
}

export function NewChatNote({
  sourceWorkspaceIds,
  groupId,
  initialPrompt = '',
  messages,
  existingItemId,
  onClose,
}: {
  readonly sourceWorkspaceIds: readonly string[];
  readonly groupId?: string;
  readonly initialPrompt?: string;
  readonly messages?: CreateConversationInput['messages'];
  readonly existingItemId?: string;
  readonly onClose: () => void;
}): ReactNode {
  const client = useApiClient();
  const navigate = useNavigate();
  const { workspaces, status: workspaceStatus } = useAccessibleWorkspaces();
  const currentWorkspace = useOptionalWorkspace();
  const [lastWorkspaceId] = useState(readLastWorkspaceId);
  const { arrangement } = useWorkspaceArrangement();
  const remembered = arrangement.groups.find((entry) => entry.id === groupId);
  const active = workspaces.filter((entry) => entry.lifecycleState === 'active');
  const [profiles, setProfiles] = useState<readonly PetProfile[]>([]);
  const [petId, setPetId] = useState('');
  const [sources, setSources] = useState<readonly string[]>(sourceWorkspaceIds);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourceSearch, setSourceSearch] = useState('');
  const [destinationOpen, setDestinationOpen] = useState(false);
  const formId = useId();
  const sourcesId = useId();
  const destinationId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [chosenDestination, setChosenDestination] = useState<{
    workspaceId: string;
    parentId: string | null;
  } | null>(null);
  const rememberedWorkspace = active.find(
    (entry) => entry.id === remembered?.lastDestinationWorkspaceId,
  );
  const current = active.find(
    (entry) => entry.id === (currentWorkspace?.workspaceId ?? lastWorkspaceId),
  );
  const defaultDestination =
    current ??
    rememberedWorkspace ??
    active.find((entry) => sourceWorkspaceIds.includes(entry.id)) ??
    active[0];
  const workspaceId = chosenDestination?.workspaceId ?? defaultDestination?.id ?? '';
  const parentId =
    chosenDestination !== null
      ? chosenDestination.parentId
      : !current && rememberedWorkspace
        ? (remembered?.lastDestinationParentId ?? null)
        : null;
  function setWorkspaceId(id: string): void {
    setChosenDestination({ workspaceId: id, parentId: null });
  }
  function setParentId(id: string | null): void {
    setChosenDestination({ workspaceId, parentId: id });
  }
  const [title, setTitle] = useState(initialPrompt || 'New chat');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [parentItem, setParentItem] = useState<Item | null>(null);
  const [unavailableParentId, setUnavailableParentId] = useState<string | null>(null);
  const [initialRequestId] = useState(() => crypto.randomUUID());
  const [createdChat, setCreatedChat] = useState<Conversation | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .query(pets.settings(), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setProfiles(value.settings.profiles);
          setPetId(value.settings.activePetId ?? '');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Pets could not be loaded.');
      });
    return () => {
      controller.abort();
    };
  }, [client]);
  const destination = active.find((entry) => entry.id === workspaceId);
  useEffect(() => {
    if (!parentId || existingItemId) return;
    const controller = new AbortController();
    void client
      .query(items.itemById(parentId), { signal: controller.signal, forceRefresh: true })
      .then((item) => {
        if (item.workspaceId !== workspaceId)
          throw new Error('Destination belongs to another workspace.');
        if (!controller.signal.aborted) {
          setParentItem(item);
          setUnavailableParentId(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailableParentId(parentId);
      });
    return () => {
      controller.abort();
    };
  }, [client, parentId, workspaceId, existingItemId]);
  const parentReady =
    parentId === null ||
    (parentItem?.id === parentId &&
      parentItem.workspaceId === workspaceId &&
      unavailableParentId !== parentId);
  const selectedSources = active.filter((entry) => sources.includes(entry.id));
  const sourceSummary =
    selectedSources.length === 0
      ? 'Choose workspaces'
      : selectedSources.length === 1
        ? selectedSources[0]?.name
        : `${String(selectedSources.length)} workspaces`;
  const unavailableSources = sources.filter((id) => !active.some((entry) => entry.id === id));
  const filteredSources = active.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(sourceSearch.toLocaleLowerCase().trim()),
  );
  const disabled =
    busy ||
    !title.trim() ||
    !petId ||
    !sources.length ||
    unavailableSources.length > 0 ||
    (!existingItemId && (!destination || !parentReady)) ||
    !confirmed;
  async function create(): Promise<void> {
    if (disabled) return;
    setBusy(true);
    setError('');
    let saved = false;
    try {
      const chat =
        createdChat ??
        (existingItemId
          ? await client.execute(
              conversations.configure(existingItemId, { sourceWorkspaceIds: sources, petId }),
            )
          : await client.execute(
              conversations.create(workspaceId, {
                title: title.trim(),
                parentId,
                sourceWorkspaceIds: [...sources],
                petId,
                ...(groupId ? { groupId } : {}),
                ...(messages ? { messages } : {}),
              }),
            ));
      saved = true;
      setCreatedChat(chat);
      if (initialPrompt.trim())
        await client.execute(
          conversations.send(chat.itemId, { requestId: initialRequestId, text: initialPrompt }),
        );
      onClose();
      void navigate(`/w/${chat.workspaceId}?item=${chat.itemId}`);
    } catch {
      setError(
        saved
          ? 'The chat was saved, but the first message could not be confirmed. Open the saved chat before sending again.'
          : 'The chat could not be created. Check your destination and pet connection.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={existingItemId ? 'Set up this chat view' : messages ? 'Save as chat note' : 'New chat'}
      initialFocus={titleRef}
      onClose={() => {
        if (!busy) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={disabled} type="submit" form={formId}>
            {busy
              ? 'Saving…'
              : createdChat
                ? 'Retry first message'
                : existingItemId
                  ? 'Set up chat'
                  : 'Create chat note'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {messages ? (
          <details>
            <summary>Preview retained transcript</summary>
            {messages.map((message, index) => (
              <div key={index}>
                <Text variant="kicker">{message.role}</Text>
                <PetMessageText workspaceId={sourceWorkspaceIds[0] ?? ''} text={message.text} />
              </div>
            ))}
          </details>
        ) : null}
        {messages ? (
          <Text>
            Only the retained visible messages will be copied. Older trimmed messages and hidden
            provider context are unavailable. Your original private conversation is kept.
          </Text>
        ) : null}
        <fieldset disabled={busy || createdChat !== null} className="flex flex-col gap-4">
          {!existingItemId ? (
            <Field label="Chat title">
              {(control) => (
                <Input
                  {...control}
                  ref={titleRef}
                  value={title}
                  maxLength={240}
                  onChange={(event) => {
                    setTitle(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          ) : null}
          <Field label="Pet">
            {(control) => (
              <Select
                {...control}
                value={petId}
                onChange={(event) => {
                  setPetId(event.currentTarget.value);
                }}
              >
                <option value="">Choose a pet</option>
                {profiles.map((pet) => (
                  <option key={pet.id} value={pet.id}>
                    {pet.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <Button
              variant="secondary"
              className="justify-between"
              aria-expanded={sourcesOpen}
              aria-controls={sourcesOpen ? sourcesId : undefined}
              onClick={() => {
                setSourcesOpen(!sourcesOpen);
              }}
            >
              <Text as="span" variant="bodySmall" className="truncate">
                Sources: {workspaceStatus === 'loading' ? 'Loading…' : sourceSummary}
              </Text>
              <Icon icon={sourcesOpen ? ChevronUp : ChevronDown} />
            </Button>
            {sourcesOpen ? (
              <div id={sourcesId} className="flex flex-col gap-2 rounded border border-divider p-3">
                <Input
                  type="search"
                  aria-label="Find a source workspace"
                  placeholder="Find a workspace…"
                  value={sourceSearch}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.preventDefault();
                  }}
                  onChange={(event) => {
                    setSourceSearch(event.currentTarget.value);
                  }}
                />
                <fieldset
                  aria-label="Source workspaces"
                  className="flex max-h-40 flex-col gap-1 overflow-y-auto"
                >
                  {filteredSources.map((entry) => (
                    <Checkbox
                      key={entry.id}
                      label={entry.name}
                      checked={sources.includes(entry.id)}
                      onChange={(event) => {
                        setSources(
                          event.currentTarget.checked
                            ? [...sources, entry.id]
                            : sources.filter((id) => id !== entry.id),
                        );
                        setConfirmed(false);
                      }}
                    />
                  ))}
                  {!filteredSources.length ? (
                    <Text variant="note">No matching workspaces.</Text>
                  ) : null}
                </fieldset>
              </div>
            ) : null}
            {unavailableSources.length > 0 && workspaceStatus !== 'loading' ? (
              <div>
                <Text role="alert">Some source workspaces are no longer available.</Text>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSources(selectedSources.map((entry) => entry.id));
                    setConfirmed(false);
                  }}
                >
                  Remove unavailable sources
                </Button>
              </div>
            ) : null}
            <Text variant="note" tone="muted">
              Your pet can read these workspaces, without changing their notes.
            </Text>
          </div>
          {!existingItemId ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Text variant="kicker">Save to</Text>
                  <Text variant="bodySmall" className="break-words">
                    {parentId
                      ? `${parentReady ? (parentItem?.title ?? 'Untitled note') : 'Checking destination…'} · `
                      : ''}
                    {destination?.name ?? 'Choose a workspace'}
                    {current?.id === workspaceId && !parentId ? ' (this workspace)' : ''}
                  </Text>
                </div>
                <Button
                  variant="ghost"
                  className="shrink-0"
                  aria-expanded={destinationOpen}
                  aria-controls={destinationOpen ? destinationId : undefined}
                  onClick={() => {
                    setDestinationOpen(!destinationOpen);
                  }}
                >
                  {destinationOpen ? 'Done' : 'Somewhere else…'}
                </Button>
              </div>
              {destinationOpen ? (
                <div
                  id={destinationId}
                  className="flex flex-col gap-3 rounded border border-divider p-3"
                >
                  <Field label="Destination workspace">
                    {(control) => (
                      <Select
                        {...control}
                        value={workspaceId}
                        onChange={(event) => {
                          setWorkspaceId(event.currentTarget.value);
                          setConfirmed(false);
                        }}
                      >
                        <option value="">Choose where to save</option>
                        {active.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  {workspaceId ? (
                    <ChatDestination
                      workspaceId={workspaceId}
                      parentId={parentId}
                      onChange={(id) => {
                        setParentId(id);
                        setConfirmed(false);
                      }}
                    />
                  ) : null}
                  {current && (workspaceId !== current.id || parentId !== null) ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setWorkspaceId(current.id);
                        setConfirmed(false);
                      }}
                    >
                      Use this workspace
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {existingItemId ? (
            <>
              <Text>
                This conversation will be stored in the existing note. Anyone who can read it can
                read the transcript, including content from the selected source workspaces.
              </Text>
              <Checkbox
                label="I confirm this destination and its sharing"
                checked={confirmed}
                onChange={(event) => {
                  setConfirmed(event.currentTarget.checked);
                }}
              />
            </>
          ) : null}
          {!existingItemId && destination ? (
            <>
              <Text>
                {destination.kind === 'shared' ? 'Shared workspace.' : 'Personal workspace.'}{' '}
                Everyone who can read this note can read the chat and any content drawn from its
                sources.
              </Text>
              <Checkbox
                label="I confirm this destination and its sharing"
                checked={confirmed}
                onChange={(event) => {
                  setConfirmed(event.currentTarget.checked);
                  if (event.currentTarget.checked) setChosenDestination({ workspaceId, parentId });
                }}
              />
            </>
          ) : null}
        </fieldset>
        {parentId && unavailableParentId === parentId ? (
          <Text role="alert">The destination note is unavailable. Choose somewhere else.</Text>
        ) : null}
        {error ? <Text role="alert">{error}</Text> : null}
        {createdChat ? (
          <Link to={`/w/${createdChat.workspaceId}?item=${createdChat.itemId}`}>
            Open saved chat
          </Link>
        ) : null}
      </form>
    </Dialog>
  );
}
