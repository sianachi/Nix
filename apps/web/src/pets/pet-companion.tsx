import {
  isCanceledError,
  items,
  pets,
  type PetAction,
  type PetConnection,
  type PetProfile,
  type PetSettings,
} from '@nix/api-client';
import { Button, Text, focusRing } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiClient } from '../api/api-client-provider';
import { useWorkspace } from '../workspaces/workspace-context';
import { PetAvatar, type PetAnimationState } from './pet-avatar';
import { usePetSettings } from './use-pet-settings';
import { usePetVoice } from './use-pet-voice';
import {
  readConversationModel,
  readDevicePreference,
  writeConversationModel,
} from './device-preferences';
import { readActionReceipt, writeActionReceipt } from './action-receipts';
import { PetWorkTools } from './pet-work-tools';
import { PetConnectionPanel } from './pet-connection-panel';
import { PetHistory } from './pet-history';
import { PetChatViewport } from './pet-chat-viewport';
import { PetMessageText } from './pet-message-text';

export function PetCompanion(): ReactElement | null {
  const { workspaceId } = useWorkspace();
  const { saved } = usePetSettings();
  const pet = saved?.settings.profiles.find((profile) => profile.id === saved.settings.activePetId);
  if (!saved?.settings.enabled || !pet) return null;
  return (
    <Companion
      key={`${workspaceId}:${pet.id}`}
      workspaceId={workspaceId}
      pet={pet}
      settings={saved.settings}
    />
  );
}

function Companion({
  workspaceId,
  pet,
  settings,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const launcher = useRef<HTMLButtonElement | null>(null);
  const [placement, setPlacement] = useState(() => readDevicePreference('placement'));
  useEffect(() => {
    const changed = () => {
      setPlacement(readDevicePreference('placement'));
    };
    window.addEventListener('nix-pet-device-changed', changed);
    return () => {
      window.removeEventListener('nix-pet-device-changed', changed);
    };
  }, []);
  return (
    <aside
      aria-label={`${pet.name} companion`}
      className={`fixed bottom-4 z-40 flex max-w-full flex-col gap-2 p-2 ${placement === 'left' ? 'left-0 items-start sm:left-4' : 'right-0 items-end sm:right-4'}`}
    >
      {open ? (
        <Conversation
          workspaceId={workspaceId}
          pet={pet}
          settings={settings}
          onClose={() => {
            setOpen(false);
            launcher.current?.focus();
          }}
        />
      ) : null}
      <Button
        ref={launcher}
        variant="ghost"
        aria-expanded={open}
        aria-label={open ? `Close ${pet.name}` : `Talk with ${pet.name}`}
        onMouseEnter={() => {
          setHover(true);
        }}
        onMouseLeave={() => {
          setHover(false);
        }}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <PetAvatar
          appearance={pet.appearance}
          state={hover ? 'hover' : 'idle'}
          motion={settings.motion}
          label={pet.name}
        />
      </Button>
    </aside>
  );
}

function Conversation({
  workspaceId,
  pet,
  settings,
  onClose,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly onClose: () => void;
}) {
  const client = useApiClient();
  const [search] = useSearchParams();
  const currentItem = search.get('item');
  const [runtime, setRuntime] = useState<PetConnection | null>(null);
  const [draft, setDraft] = useState('');
  const [shared, setShared] = useState<{ itemId: string; text: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [model, setModel] = useState(() => readConversationModel(workspaceId, pet.id));
  const [models, setModels] = useState<NonNullable<PetConnection['models']>>([]);
  const [workspaceAccess, setWorkspaceAccess] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const narrationPending = useRef(false);
  const voice = usePetVoice((text) => {
    setDraft((old) => `${old}${old ? ' ' : ''}${text}`.slice(0, 8000));
  });
  const messages = runtime?.messages ?? [];
  const running = runtime?.state === 'thinking';
  const approvalPending =
    (runtime?.tools?.some((tool) => tool.status === 'pending') ?? false) ||
    messages.some((message) =>
      message.actions.some(
        (_, actionIndex) =>
          !(
            outcomes[`${message.id}:${String(actionIndex)}`] ??
            readActionReceipt(`${message.id}:${String(actionIndex)}`)
          ),
      ),
    );
  const animation: PetAnimationState = voice.listening
    ? 'listening'
    : voice.speaking
      ? 'speaking'
      : working
        ? 'working'
        : approvalPending
          ? 'awaiting-approval'
          : running || busy
            ? 'thinking'
            : error || runtime?.state === 'error'
              ? 'error'
              : runtime?.state === 'success'
                ? 'success'
                : 'idle';

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dialog.current?.contains(document.activeElement)) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    input.current?.focus();
    void client
      .execute(pets.runtime({ operation: 'models' }), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setModels(value.models ?? []);
      })
      .catch(() => {
        /* The provider default remains available if model discovery fails. */
      });
    const poll = async () => {
      try {
        const result = await client.execute(
          pets.runtime({ operation: 'read', workspaceId, petId: pet.id }),
          { signal: controller.signal },
        );
        if (!isAborted(controller.signal)) setRuntime(result);
      } catch (cause) {
        if (!isCanceledError(cause) && !isAborted(controller.signal))
          setError('Conversation could not be loaded. Check your connection and try Refresh.');
      }
      if (!isAborted(controller.signal))
        timer = setTimeout(() => {
          void poll();
        }, 3000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, workspaceId, pet.id]);

  useEffect(() => {
    if (!narrationPending.current || runtime?.state !== 'success') return;
    narrationPending.current = false;
    const last = runtime.messages?.at(-1);
    if (settings.narration && last?.role === 'assistant') voice.speak(last.text);
  }, [runtime, settings.narration, voice]);

  async function command(operation: 'send' | 'interrupt' | 'reset' | 'read') {
    const controller = lifetime.current;
    if (busy || !controller || isAborted(controller.signal)) return;
    setBusy(true);
    setError('');
    try {
      const result = await client.execute(
        pets.runtime({
          operation,
          workspaceId,
          petId: pet.id,
          ...(operation === 'send'
            ? {
                requestId,
                text: draft,
                model,
                workspaceAccess,
                ...(shared ? { itemId: shared.itemId, sharedText: shared.text } : {}),
              }
            : {}),
        }),
        { signal: controller.signal },
      );
      if (isAborted(controller.signal)) return;
      setRuntime(result);
      if (operation === 'send') {
        narrationPending.current = true;
        setDraft('');
        setShared(null);
        setRequestId(crypto.randomUUID());
      }
      if (operation === 'reset') setOutcomes({});
    } catch (cause) {
      if (!isCanceledError(cause) && !isAborted(controller.signal))
        setError(
          'The request could not be confirmed. Refresh before retrying; your draft is preserved.',
        );
    } finally {
      if (!isAborted(controller.signal)) setBusy(false);
    }
  }

  function shareSelection() {
    const text = window.getSelection()?.toString().trim() ?? '';
    if (!currentItem || !text) {
      setError('Select text in the current item, then choose Share selected text.');
      return;
    }
    setShared({ itemId: currentItem, text: text.slice(0, 16000) });
    setError('');
  }

  async function approve(action: PetAction, key: string) {
    const controller = lifetime.current;
    if (
      working ||
      outcomes[key] ||
      readActionReceipt(key) ||
      !controller ||
      isAborted(controller.signal)
    )
      return;
    setWorking(true);
    setError('');
    // A write is never retried automatically, including after an ambiguous network response.
    writeActionReceipt(
      key,
      'Not confirmed. Check the workspace before attempting this change again.',
    );
    setOutcomes((old) => ({ ...old, [key]: 'Applying…' }));
    try {
      if (action.kind === 'rename_item') {
        const item = await client.query(items.itemById(action.itemId), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (item.workspaceId !== workspaceId) throw new Error('Action is outside this workspace.');
        await client.execute(items.renameItem(workspaceId, action.itemId, action.title), {
          signal: controller.signal,
        });
      } else {
        await client.execute(items.createItem(workspaceId, { type: 'note', title: action.title }), {
          signal: controller.signal,
        });
      }
      writeActionReceipt(key, 'Applied');
      if (!isAborted(controller.signal)) setOutcomes((old) => ({ ...old, [key]: 'Applied' }));
    } catch {
      if (!isAborted(controller.signal))
        setOutcomes((old) => ({
          ...old,
          [key]: 'Not confirmed. Check the workspace before attempting this change again.',
        }));
    } finally {
      if (!isAborted(controller.signal)) setWorking(false);
    }
  }

  return (
    <div
      ref={dialog}
      role="dialog"
      tabIndex={-1}
      aria-modal={false}
      aria-label={`Conversation with ${pet.name}`}
      className="flex h-[calc(100dvh-var(--spacing)*36)] max-h-192 w-128 max-w-full flex-col overflow-hidden rounded-lg border border-divider bg-background text-foreground shadow-lg"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-divider px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-12 shrink-0 overflow-hidden">
            <div className="origin-top-left scale-50">
              <PetAvatar
                appearance={pet.appearance}
                motion={settings.motion}
                state={animation}
                label={`${pet.name}: ${animation}`}
              />
            </div>
          </div>
          <Text variant="h3" as="h2">
            {pet.name}
          </Text>
          <Text role="status" variant="note">
            {animation === 'awaiting-approval'
              ? 'Needs approval'
              : running
                ? 'Thinking…'
                : animation === 'success'
                  ? 'Replied'
                  : animation}
          </Text>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <details className="max-h-40 shrink-0 overflow-y-auto border-b border-divider px-4 py-2">
        <summary className={`cursor-pointer ${focusRing}`}>
          <Text as="span" variant="note">
            Chat options and connection
          </Text>
        </summary>
        <div className="flex flex-col gap-3 py-2">
          <Text variant="note" tone="muted">
            Workspace tools run only when enabled and approved. Approved reads share their results
            with ChatGPT.{' '}
            <Link to={`/w/${workspaceId}/settings`} className="underline">
              Connection and pet settings
            </Link>
          </Text>
          {runtime?.reason && runtime.status === 'connected' ? (
            <Text variant="note" tone="muted">
              {runtime.reason}
            </Text>
          ) : null}
          {runtime && runtime.status !== 'connected' ? <PetConnectionPanel compact /> : null}
          <label className="flex flex-col gap-2">
            <Text variant="note">Codex model</Text>
            <select
              aria-label="Codex model"
              value={model}
              disabled={running || busy}
              className={`rounded border border-divider bg-background p-2 text-foreground ${focusRing}`}
              onChange={(event) => {
                setModel(event.currentTarget.value);
                writeConversationModel(workspaceId, pet.id, event.currentTarget.value);
              }}
            >
              <option value="">Account default</option>
              {model && !models.some((entry) => entry.id === model) ? (
                <option value={model}>{model} (checking availability)</option>
              ) : null}
              {models.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
      <PetChatViewport
        latestKey={`${messages.at(-1)?.id ?? ''}:${runtime?.tools?.at(-1)?.id ?? ''}`}
      >
        {runtime?.state === 'error' ? (
          <Text role="alert">
            {runtime.reason || 'The response did not finish. Refresh and try again.'}
          </Text>
        ) : null}
        {messages.length === 0 ? (
          <Text variant="note">
            Ask a question, or enable workspace tools to find notes, write content, and organise
            your work.
          </Text>
        ) : (
          messages.map((message, index) => (
            <div
              key={message.id}
              data-pet-latest-message={index === messages.length - 1 ? '' : undefined}
              className={`flex shrink-0 flex-col gap-2 ${message.role === 'user' ? 'rounded-lg bg-surface p-3' : ''}`}
            >
              <Text variant="note" tone="muted">
                {message.role === 'user' ? 'You' : pet.name}
              </Text>
              <PetMessageText text={message.text} workspaceId={workspaceId} />
              {message.role === 'assistant' && voice.canSpeak ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    voice.speak(message.text);
                  }}
                >
                  Read aloud
                </Button>
              ) : null}
              {message.actions.map((action, actionIndex) => {
                const key = `${message.id}:${String(actionIndex)}`;
                const outcome = outcomes[key] ?? readActionReceipt(key);
                return (
                  <div key={key} className="flex flex-col gap-2 border border-divider p-3">
                    <Text variant="note">
                      {action.kind === 'create_item' ? 'Create a blank note' : 'Rename item'}:{' '}
                      {action.title}
                    </Text>
                    {action.kind === 'rename_item' ? (
                      <Link
                        to={`/w/${workspaceId}/?item=${encodeURIComponent(action.itemId)}`}
                        className="underline"
                      >
                        Inspect target item
                      </Link>
                    ) : null}
                    {outcome ? (
                      <Text role="status" variant="note">
                        {outcome}
                      </Text>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          variant="secondary"
                          disabled={working || running}
                          onClick={() => {
                            void approve(action, key);
                          }}
                        >
                          Approve change
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            writeActionReceipt(key, 'Declined');
                            setOutcomes((old) => ({ ...old, [key]: 'Declined' }));
                          }}
                        >
                          Decline
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
        {runtime ? (
          <PetWorkTools
            client={client}
            runtime={runtime}
            workspaceId={workspaceId}
            petId={pet.id}
            onChange={setRuntime}
          />
        ) : null}
        {error || voice.error ? <Text role="alert">{error || voice.error}</Text> : null}
      </PetChatViewport>
      <div className="flex max-h-[50dvh] shrink-0 flex-col gap-2 overflow-y-auto border-t border-divider p-3">
        {shared ? (
          <div className="flex flex-col gap-2">
            <Text variant="note">
              Shared selection ({shared.text.length} characters): {shared.text.slice(0, 120)}
            </Text>
            <Button
              variant="ghost"
              onClick={() => {
                setShared(null);
              }}
            >
              Remove shared text
            </Button>
          </div>
        ) : null}
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) void command('send');
          }}
        >
          <label htmlFor="pet-message">
            <Text variant="note">Message {pet.name}</Text>
          </label>
          <textarea
            id="pet-message"
            ref={input}
            rows={2}
            maxLength={8000}
            value={draft}
            className={`max-h-32 w-full resize-none rounded border border-divider bg-background p-2 text-foreground ${focusRing}`}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setRequestId(crypto.randomUUID());
            }}
          />
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={workspaceAccess}
              disabled={running}
              onChange={(event) => {
                setWorkspaceAccess(event.currentTarget.checked);
              }}
            />
            <Text variant="note">Allow workspace tools for this message (approval required)</Text>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || running || !draft.trim() || runtime?.status !== 'connected'}
            >
              Send
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void command('read');
              }}
            >
              Refresh
            </Button>
            {running ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void command('interrupt');
                }}
              >
                Stop response
              </Button>
            ) : null}
          </div>
        </form>
        <details>
          <summary className={`cursor-pointer ${focusRing}`}>
            <Text as="span" variant="note">
              More actions and history
            </Text>
          </summary>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={shareSelection}
            >
              Share selected text
            </Button>
            {voice.canDictate ? (
              <Button variant="ghost" disabled={running} onClick={voice.dictate}>
                Dictate
              </Button>
            ) : (
              <Text variant="note" tone="muted">
                Dictation unavailable in this browser
              </Text>
            )}
            {voice.listening || voice.speaking ? (
              <Button variant="secondary" onClick={voice.stop}>
                Stop audio
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={busy || running}
              onClick={() => {
                void command('reset');
              }}
            >
              New conversation
            </Button>
            <Button
              variant="ghost"
              disabled={!messages.length}
              onClick={() => {
                const text = messages
                  .map(
                    (message) => `${message.role === 'user' ? 'You' : pet.name}\n\n${message.text}`,
                  )
                  .join('\n\n---\n\n');
                const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
                const link = document.createElement('a');
                link.href = url;
                link.download = 'nix-companion-conversation.md';
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export conversation
            </Button>
          </div>
          <PetHistory client={client} workspaceId={workspaceId} petId={pet.id} name={pet.name} />
        </details>
      </div>
    </div>
  );
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
