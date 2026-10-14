import { pets, type PetConnection, type PetMessage, type NixClient } from '@nix/api-client';
import { Button, Input, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';

export function exportPetMessages(messages: readonly PetMessage[], name: string): void {
  const text = messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role === 'user' ? 'You' : name}\n\n${message.text}`)
    .join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'nix-companion-conversation.md';
  link.click();
  URL.revokeObjectURL(url);
}

/** The title a conversation may be given: the same bounds Core and the worker enforce. */
function validTitle(value: string): boolean {
  const title = value.trim();
  return title.length > 0 && title.length <= 120 && !/\p{Cc}/u.test(title);
}

/** One line to rename a conversation: Enter saves, Escape cancels. Escape is kept from reaching the
 * conversation behind it, which would otherwise treat it as "back out of this panel". */
export function TitleEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  readonly initial: string;
  readonly busy: boolean;
  readonly onSave: (title: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Input
        ref={field}
        aria-label="Conversation title"
        value={value}
        maxLength={120}
        disabled={busy}
        className="min-w-0 flex-1"
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && validTitle(value)) {
            event.preventDefault();
            onSave(value.trim());
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <Button
        variant="secondary"
        disabled={busy || !validTitle(value)}
        onClick={() => {
          onSave(value.trim());
        }}
      >
        Save title
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export function PetHistory({
  workspaceId,
  petId,
  name,
  client,
  rootItemId,
  running = false,
  onResumed,
}: {
  readonly workspaceId: string;
  readonly petId: string;
  readonly name: string;
  readonly client: Pick<NixClient, 'execute'>;
  readonly rootItemId?: string | undefined;
  /** A turn is running in the live conversation: it cannot be swapped out until it stops. */
  readonly running?: boolean;
  /** Called with the worker's answer once an archive has become the live conversation. */
  readonly onResumed?: (connection: PetConnection) => void;
}): ReactElement {
  const [history, setHistory] = useState<NonNullable<PetConnection['history']>>([]);
  const [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<PetMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, []);
  async function load(
    operation: 'history' | 'read_history' | 'delete_history' | 'rename' | 'resume_history',
    historyId = '',
    text = '',
  ) {
    setBusy(true);
    setError('');
    try {
      const signal = lifetime.current?.signal;
      if (!signal || signal.aborted) return;
      const result = await client.execute(
        pets.runtime({
          operation,
          workspaceId,
          petId,
          ...(rootItemId ? { rootItemId } : {}),
          ...(historyId ? { historyId } : {}),
          ...(text ? { text } : {}),
        }),
        { signal },
      );
      if (isAborted(signal)) return;
      if (operation === 'resume_history') {
        onResumed?.(result);
      } else if (operation === 'read_history') {
        setMessages(result.messages ?? []);
      } else if (operation === 'rename') {
        setHistory(result.history ?? []);
        setRenaming(false);
      } else {
        setHistory(result.history ?? []);
        setLoaded(true);
        setMessages([]);
        setSelected('');
        setConfirm(false);
        setRenaming(false);
      }
    } catch {
      setError('History could not be loaded or changed. Try again.');
    } finally {
      setBusy(false);
    }
  }
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? history.filter((entry) => entry.title.toLowerCase().includes(needle))
    : history;
  const current = history.find((entry) => entry.id === selected);
  return (
    <section aria-label="Companion history" className="flex min-w-0 flex-col gap-2">
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => {
          void load('history');
        }}
      >
        Conversation history
      </Button>
      {loaded ? (
        <>
          <Text variant="note">
            Previous conversations are saved when you start a new one. Up to 32 are kept for this
            pet {rootItemId ? 'about this note' : 'in this workspace'}.
          </Text>
          {history.length ? (
            <Input
              type="search"
              aria-label="Search saved conversations"
              placeholder="Search by title"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
            />
          ) : null}
          {shown.length ? (
            <ul aria-label="Saved conversations" className="flex min-w-0 flex-col gap-1">
              {shown.map((entry) => (
                <li key={entry.id} className="min-w-0">
                  <Button
                    variant={entry.id === selected ? 'secondary' : 'ghost'}
                    aria-current={entry.id === selected ? 'true' : undefined}
                    disabled={busy}
                    className="w-full min-w-0 justify-start"
                    onClick={() => {
                      setSelected(entry.id);
                      setMessages([]);
                      setConfirm(false);
                      setRenaming(false);
                      void load('read_history', entry.id);
                    }}
                  >
                    <span className="min-w-0 truncate">
                      {new Date(entry.createdAt).toLocaleDateString()} —{' '}
                      {entry.title || 'Untitled conversation'}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Text variant="note" tone="muted">
              {history.length ? 'No conversation matches that title.' : 'No previous conversations'}
            </Text>
          )}
          {current ? (
            <>
              {renaming ? (
                <TitleEditor
                  initial={current.title}
                  busy={busy}
                  onSave={(title) => {
                    void load('rename', current.id, title);
                  }}
                  onCancel={() => {
                    setRenaming(false);
                  }}
                />
              ) : (
                <Button
                  variant="ghost"
                  aria-label="Rename saved conversation"
                  disabled={busy}
                  onClick={() => {
                    setRenaming(true);
                  }}
                >
                  Rename conversation
                </Button>
              )}
              <Button
                variant="secondary"
                aria-label="Continue this conversation"
                disabled={busy || running}
                onClick={() => {
                  void load('resume_history', current.id);
                }}
              >
                Continue this conversation
              </Button>
              <Text variant="note" tone="muted">
                {running
                  ? 'Stop the running turn to continue another conversation.'
                  : 'Your current conversation is saved to history.'}
              </Text>
            </>
          ) : null}
          {messages.length ? (
            <>
              <div className="flex min-w-0 max-h-60 flex-col gap-2 overflow-y-auto overscroll-contain">
                {messages.map((message) => (
                  <Text
                    key={message.id}
                    variant="note"
                    className="whitespace-pre-wrap wrap-anywhere"
                  >
                    {message.role === 'system'
                      ? message.text
                      : `${message.role === 'user' ? 'You' : name}: ${message.text}`}
                  </Text>
                ))}
              </div>
              <Button
                variant="ghost"
                aria-label="Export saved conversation"
                onClick={() => {
                  exportPetMessages(messages, name);
                }}
              >
                Export conversation
              </Button>
              {confirm ? (
                <>
                  <Text variant="note">
                    Permanently delete this saved Nix conversation? This cannot be undone. It does
                    not delete provider-side records.
                  </Text>
                  <Button
                    variant="secondary"
                    aria-label="Delete saved conversation permanently"
                    disabled={busy}
                    onClick={() => {
                      void load('delete_history', selected);
                    }}
                  >
                    Delete permanently
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setConfirm(false);
                    }}
                  >
                    Keep conversation
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  aria-label="Remove saved conversation"
                  onClick={() => {
                    setConfirm(true);
                  }}
                >
                  Remove conversation
                </Button>
              )}
            </>
          ) : null}
        </>
      ) : null}
      {error ? <Text role="alert">{error}</Text> : null}
    </section>
  );
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
