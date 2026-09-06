import { pets, type PetConnection, type PetMessage, type NixClient } from '@nix/api-client';
import { Button, Text, focusRing } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';

export function exportPetMessages(messages: readonly PetMessage[], name: string): void {
  const text = messages
    .map((message) => `${message.role === 'user' ? 'You' : name}\n\n${message.text}`)
    .join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'nix-companion-conversation.md';
  link.click();
  URL.revokeObjectURL(url);
}

export function PetHistory({
  workspaceId,
  petId,
  name,
  client,
}: {
  readonly workspaceId: string;
  readonly petId: string;
  readonly name: string;
  readonly client: Pick<NixClient, 'execute'>;
}): ReactElement {
  const [history, setHistory] = useState<NonNullable<PetConnection['history']>>([]);
  const [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<PetMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, []);
  async function load(operation: 'history' | 'read_history' | 'delete_history', historyId = '') {
    setBusy(true);
    setError('');
    try {
      const signal = lifetime.current?.signal;
      if (!signal || signal.aborted) return;
      const result = await client.execute(
        pets.runtime({ operation, workspaceId, petId, ...(historyId ? { historyId } : {}) }),
        { signal },
      );
      if (isAborted(signal)) return;
      if (operation === 'read_history') {
        setMessages(result.messages ?? []);
      } else {
        setHistory(result.history ?? []);
        setLoaded(true);
        setMessages([]);
        setSelected('');
        setConfirm(false);
      }
    } catch {
      setError('History could not be loaded or changed. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Companion history" className="flex flex-col gap-2">
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
            pet in this workspace.
          </Text>
          <select
            aria-label="Saved conversation"
            value={selected}
            disabled={busy}
            className={`rounded border border-divider bg-background p-2 text-foreground ${focusRing}`}
            onChange={(event) => {
              const id = event.currentTarget.value;
              setSelected(id);
              setMessages([]);
              setConfirm(false);
              if (id) void load('read_history', id);
            }}
          >
            <option value="">
              {history.length ? 'Choose a conversation' : 'No previous conversations'}
            </option>
            {history.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {new Date(entry.createdAt).toLocaleDateString()} — {entry.title}
              </option>
            ))}
          </select>
          {messages.length ? (
            <>
              <div className="flex max-h-60 flex-col gap-2 overflow-y-auto">
                {messages.map((message) => (
                  <Text key={message.id} variant="note" className="whitespace-pre-wrap break-words">
                    {message.role === 'user' ? 'You' : name}: {message.text}
                  </Text>
                ))}
              </div>
              <Button
                variant="ghost"
                onClick={() => {
                  exportPetMessages(messages, name);
                }}
              >
                Export saved conversation
              </Button>
              {confirm ? (
                <>
                  <Text variant="note">
                    Permanently delete this saved Nix conversation? This cannot be undone. It does
                    not delete provider-side records.
                  </Text>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      void load('delete_history', selected);
                    }}
                  >
                    Delete saved conversation permanently
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
                  onClick={() => {
                    setConfirm(true);
                  }}
                >
                  Remove saved conversation
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
