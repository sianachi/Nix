import {
  conversations,
  items,
  pets,
  type Item,
  type PetProfile,
  type CreateConversationInput,
  type Conversation,
} from '@nix/api-client';
import { Button, Checkbox, Field, Input, Select, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useWorkspaceArrangement } from '../../workspaces/use-workspace-arrangement';
import { PetMessageText } from '../../pets/pet-message-text';
import { Link, useNavigate } from 'react-router';
import { useApiClient } from '../../api/api-client-provider';
import { useAccessibleWorkspaces } from '../../workspaces/workspace-context';

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
  const { workspaces } = useAccessibleWorkspaces();
  const { arrangement } = useWorkspaceArrangement();
  const remembered = arrangement.groups.find((entry) => entry.id === groupId);
  const active = workspaces.filter((entry) => entry.lifecycleState === 'active');
  const [profiles, setProfiles] = useState<readonly PetProfile[]>([]);
  const [petId, setPetId] = useState('');
  const [sources, setSources] = useState<readonly string[]>(sourceWorkspaceIds);
  const [chosenDestination, setChosenDestination] = useState<{
    workspaceId: string;
    parentId: string | null;
  } | null>(null);
  const rememberedWorkspace = active.find(
    (entry) => entry.id === remembered?.lastDestinationWorkspaceId,
  );
  const workspaceId = chosenDestination?.workspaceId ?? rememberedWorkspace?.id ?? '';
  const parentId =
    chosenDestination !== null
      ? chosenDestination.parentId
      : rememberedWorkspace
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
  async function create(): Promise<void> {
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
    <section
      aria-label="New chat note"
      className="flex flex-col gap-4 rounded-lg border border-divider bg-surface p-4"
    >
      <Text as="h2" variant="h4">
        {existingItemId ? 'Set up this chat view' : messages ? 'Save as chat note' : 'New chat'}
      </Text>
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
        <fieldset className="flex flex-col gap-2">
          <legend>Source workspaces</legend>
          {active.map((entry) => (
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
              }}
            />
          ))}
        </fieldset>
        <Text variant="note" tone="muted">
          Analysis can read the selected workspaces. It cannot change their notes.
        </Text>
        {!existingItemId ? (
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
        ) : null}
        {!existingItemId && workspaceId ? (
          <ChatDestination
            workspaceId={workspaceId}
            parentId={parentId}
            onChange={(id) => {
              setParentId(id);
              setConfirmed(false);
            }}
          />
        ) : null}
        {existingItemId ? (
          <>
            <Text>
              This conversation will be stored in the existing note. Anyone who can read it can read
              the transcript, including content from the selected source workspaces.
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
              {destination.kind === 'shared'
                ? 'This is a shared workspace.'
                : 'This is your personal workspace.'}{' '}
              The saved transcript will be readable by everyone who can read the destination note,
              including content drawn from other sources.
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
      </fieldset>
      {error ? <Text role="alert">{error}</Text> : null}
      {createdChat ? (
        <Link to={`/w/${createdChat.workspaceId}?item=${createdChat.itemId}`}>Open saved chat</Link>
      ) : null}
      <div className="flex gap-2">
        <Button
          disabled={
            busy ||
            !title.trim() ||
            !petId ||
            !sources.length ||
            (!existingItemId && !destination) ||
            !confirmed
          }
          onClick={() => void create()}
        >
          {busy
            ? 'Saving…'
            : createdChat
              ? 'Retry first message'
              : existingItemId
                ? 'Set up chat'
                : 'Create chat note'}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
